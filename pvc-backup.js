const util = require("util");
const exec = util.promisify(require("child_process").exec);
const { Command } = require("commander");
const program = new Command();

const k8s = require("@kubernetes/client-node");

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

program
  .version("1.0.0", "-v, --version")
  .usage("[OPTIONS]...")
  .option(
    "-n, --namespace <namespace>",
    'The namespace (default is "default")',
    "default"
  )
  .option("-d, --debug", "Debug", false)
  .parse(process.argv);

const options = program.opts();
// console.log(`Options: ${JSON.stringify(options)}`);
const debug = options.debug;

async function gatherPVCs(kc, namespace) {
  try {
    let myPVCs = [];

    const k8sCoreV1Api = kc.makeApiClient(k8s.CoreV1Api);
    const k8sAppsV1Api = kc.makeApiClient(k8s.AppsV1Api);

    // Find deployments and their PVCs

    // const deployments = await client.apis.apps.v1.namespaces(namespace).deployments().get();

    const deployments = await k8sAppsV1Api.listNamespacedDeployment(namespace);

    if (debug) console.log(deployments);
    // See also https://knode4.lan:6443/apis/apps/v1/namespaces/default/deployments

    for (let item of deployments.body.items) {
      if (item.spec.template.spec.volumes)
        for (volumes of item.spec.template.spec.volumes) {
          if (volumes.persistentVolumeClaim) {
            myPVCs.push({
              deployment: item.metadata.name,
              claimName: volumes.persistentVolumeClaim.claimName,
            });
          }
        }
    }
    if (debug) console.log(JSON.stringify(myPVCs));

    const pvcs = await k8sCoreV1Api.listNamespacedPersistentVolumeClaim(
      namespace
    );
    if (debug) console.log(JSON.stringify(pvcs));

    for (let item of pvcs.body.items) {
      let ignore = false;
      if (item.spec.storageClassName !== "local-path") {
        console.error(
          `${item.metadata.name}: Cannot handle storage provider ${item.spec.storageClassName}.`
        );
        ignore = true;
      }
      if (item.status.phase !== "Bound") {
        console.error(
          `${item.metadata.name}: Cannot handle PVC which is ${item.status.phase} instead of "Bound"`
        );
        ignore = true;
      }
      if (
        item.status.accessModes.length === 1 &&
        item.status.accessModes[0] !== "ReadWriteOnce"
      ) {
        console.error(
          `${item.metadata.name}: Cannot handle PVCs which are ${item.status.accessModes} instead of "ReadWriteOnce"`
        );
        ignore = true;
      }
      if (!ignore) {
        let foundIt = false;
        for (let i in myPVCs) {
          if (myPVCs[i].claimName === item.metadata.name) {
            foundIt = true;
            myPVCs[i].node =
              item.metadata.annotations["volume.kubernetes.io/selected-node"];
            myPVCs[i].path = item.spec.volumeName;
          }
        }
        if (!foundIt) {
          console.error(
            `PVC ${item.metadata.name} should have existed, but it does not!`
          );
        }
      } else {
        console.log(`Ignoring ${item.metadata.name}.`);
      }
    }
    return myPVCs;
  } catch (err) {
    console.error("Error: ", err);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function setReplicas(kc, namespace, deployment, replicaCount) {
  const k8sAppsV1Api = kc.makeApiClient(k8s.AppsV1Api);

  // Scale deployment to 0 for backup and probably 1 otherwise
  if (debug)
    console.log(`Changing ${deployment} to ${replicaCount} replicas...`);
  else {
    // See https://github.com/kubernetes-client/javascript/issues/19#issuecomment-582886605
    const headers = {
      "content-type": "application/strategic-merge-patch+json",
    };
    await k8sAppsV1Api.patchNamespacedDeployment(
      deployment,
      namespace,
      {
        spec: {
          replicas: replicaCount,
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      { headers }
    );
  }
  if (debug) console.log(`...Done`);
  // Wait at least 1s and at most 10s
  else {
    for (let i = 0; i < 10; ++i) {
      let state = await k8sAppsV1Api.readNamespacedDeployment(
        deployment,
        namespace
      );
      let replicas = state.body.spec.replicas;
      if (debug) console.log(`replicas=${replicas}`);
      await sleep(1000);
      if (replicas === replicaCount) break;
    }
  }
}

function todayDate() {
  let a = new Date();
  let year = a.getFullYear();
  let month = a.getMonth() + 1;
  let day = a.getDate();
  return `${year}-${month < 10 ? "0" + month : "" + month}-${
    day < 10 ? "0" + day : "" + day
  }`;
}

// noinspection SpellCheckingInspection
async function doBackup(kc, namespace, pvcs) {
  // Gather deployments as we handle one deployment at a time
  let deployments = new Set();

  for (let item of pvcs) {
    deployments.add(item.deployment);
  }

  for (let deployment of deployments) {
    await setReplicas(kc, namespace, deployment, 0);

    if (debug) console.log("Running backup jobs:");
    for (let volume in pvcs) {
      if (pvcs[volume].deployment === deployment) {
        // console.log(`ssh ${pvcs[volume].node}.lan  -- sudo tar -C /var/lib/rancher/k3s/storage -c -f - ${pvcs[volume].path} | xz -2 > ${pvcs[volume].claimName}-${todayDate()}.tar.xz`);
        console.log(`Running backup for ${deployment} and volume ${volume}...`);
        if (debug) {
          console.log(
            `ssh ${
              pvcs[volume].node
            }.lan  -- sudo tar -C /var/lib/rancher/k3s/storage -c -f - ${
              pvcs[volume].path
            }_${namespace}_${pvcs[volume].claimName} | xz -2 > ${
              pvcs[volume].claimName
            }-${todayDate()}.tar.xz`
          );
        } else {
          const { stdout, stderr } = await exec(
            `ssh ${
              pvcs[volume].node
            }.lan  -- sudo tar -C /var/lib/rancher/k3s/storage -c -f - ${
              pvcs[volume].path
            }_${namespace}_${pvcs[volume].claimName} | xz -2 > ${
              pvcs[volume].claimName
            }-${todayDate()}.tar.xz`
          );
          if (debug) {
            console.log(`stdout: ${stdout}`);
            console.log(`stderr: ${stderr}`);
          }
        }
        if (debug) {
          console.log("...end.");
        }
      }
    }
    await setReplicas(kc, namespace, deployment, 1);
  }
}

async function main() {
  // Using @kubernetes/client-node is a bit more complex, but here's a working sample:
  // const k8sCoreV1Api = kc.makeApiClient(k8s.CoreV1Api);
  //let res = await k8sCoreV1Api.listNamespacedPod('default');
  //console.log(res.body);
  //console.log(res.body.items[0].metadata);

  let pvcs = await gatherPVCs(kc, options.namespace);
  console.log(JSON.stringify(pvcs, null, "  "));
  await doBackup(kc, options.namespace, pvcs);
}

main();
