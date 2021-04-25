const util = require('util');
const exec = util.promisify(require('child_process').exec);

const Client = require('kubernetes-client').Client;

const { Command } = require('commander');
const program = new Command();

program
    .version('1.0.0', '-v, --version')
    .usage('[OPTIONS]...')
    .option('-n, --namespace <namespace>', 'The namespace (default is "default")', 'default')
    .option('-w, --wait N', 'Wait N seconds for the replica count to change (default is 10)', 10)
    .option('-d, --debug', 'Debug', false)
    .parse(process.argv);

const debug = program.debug;
const waitTime = program.wait;

async function gatherPVCs(client, namespace) {
    try {
        let myPVCs=[];

        // Find deployments and their PVCs
        const deployments = await client.apis.apps.v1.namespaces(namespace).deployments().get();
        // See also https://knode4.lan:6443/apis/apps/v1/namespaces/default/deployments

        for (let item of deployments.body.items) {

            if (item.spec.template.spec.volumes)
                for (volumes of item.spec.template.spec.volumes) {
                    if (volumes.persistentVolumeClaim) {

                        myPVCs.push({
                            deployment: item.metadata.name,
                            claimName: volumes.persistentVolumeClaim.claimName
                        });
                    }
                }
        }
        if (debug)
            console.log(JSON.stringify(myPVCs));

        const pvcs = await client.api.v1.namespaces(namespace).persistentvolumeclaims.get();
        for (let item of pvcs.body.items) {
            let ignore=false;
            if (item.spec.storageClassName !== "local-path") {
                console.error(`${item.metadata.name}: Cannot handle storage provider ${item.spec.storageClassName}.`);
                ignore=true;
            }
            if (item.status.phase !== "Bound") {
                console.error(`${item.metadata.name}: Cannot handle PVC which is ${item.status.phase} instead of "Bound"`);
                ignore = true;
            }
            if (item.status.accessModes.length===1 && item.status.accessModes[0] !== "ReadWriteOnce") {
                console.error(`${item.metadata.name}: Cannot handle PVCs which are ${item.status.accessModes} instead of "ReadWriteOnce"`);
                ignore = true;
            }
            if (!ignore) {
                let foundIt=false;
                for (let i in myPVCs) {
                    if (myPVCs[i].claimName === item.metadata.name) {
                        foundIt = true;
                        myPVCs[i].node = item.metadata.annotations["volume.kubernetes.io/selected-node"];
                        myPVCs[i].path = item.spec.volumeName;
                    }
                }
                if (!foundIt) {
                    console.error(`PVC ${item.metadata.name} should have existed, but it does not!`);
                }
            } else {
                console.log(`Ignoring ${item.metadata.name}.`);
            }
        }
        return myPVCs;
    } catch (err) {
        console.error('Error: ', err);
    }
}


function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function setReplicas(client, namespace, deployment, replicaCount) {
    // Scale deployment to 0 for backup and probably 1 otherwise
    if (debug) {
        console.log(`Changing ${deployment} to ${replicaCount} replicas...`)
    }
    else {
        await client.apis.apps.v1.ns(namespace).deployments(deployment).patch({
            body: {
                spec: {
                    replicas: replicaCount
                }
            }
        });
    }
    if (debug) console.log(`...Done`);
    // Wait at least 1s and at most waitTime seconds
    else {
        for (let i=0; i<waitTime; ++i) {
            let state = await client.apis.apps.v1.ns(namespace).deployments(deployment).get();
            let replicas = state.body.spec.replicas;
            if (debug) console.log(`replicas=${replicas}`);
            await sleep(1000);
            if (replicas === replicaCount) break;
        }
    }
}

function todayDate() {
    let a=new Date();
    let year=a.getFullYear();
    let month=a.getMonth()+1;
    let day=a.getDate();
    return `${year}-${month<10?"0"+month:""+month}-${day<10?"0"+day:""+day}`;
}

// noinspection SpellCheckingInspection
async function doBackup(client, namespace, pvcs) {
    // Gather deployments as we handle one deployment at a time
    let deployments=new Set();

    for (let item of pvcs) {
        deployments.add(item.deployment);
    }

    for (let deployment of deployments) {
        await setReplicas(client, namespace, deployment, 0);

        if (debug) console.log("Running backup jobs:");
        for (let volume in pvcs) {
            if (pvcs[volume].deployment === deployment) {
                // console.log(`ssh ${pvcs[volume].node}.lan  -- sudo tar -C /var/lib/rancher/k3s/storage -c -f - ${pvcs[volume].path} | xz -2 > ${pvcs[volume].claimName}-${todayDate()}.tar.xz`);
                console.log(`Running backup for ${deployment} and volume ${volume}...`);
                if (debug) {
                    console.log(`ssh ${pvcs[volume].node}.lan  -- sudo tar -C /var/lib/rancher/k3s/storage -c -f - ${pvcs[volume].path} | xz -2 > ${pvcs[volume].claimName}-${todayDate()}.tar.xz`);
                    }
                else {
                    const { stdout, stderr } = await exec(`ssh ${pvcs[volume].node}.lan  -- sudo tar -C /var/lib/rancher/k3s/storage -c -f - ${pvcs[volume].path} | xz -2 > ${pvcs[volume].claimName}-${todayDate()}.tar.xz`);
                    if (debug) {
                        console.log(`stdout: ${stdout}`);
                        console.log(`stderr: ${stderr}`);
                    }
                }
                if (debug) {
                    console.log('...end.');
                }
            }
        }
        await setReplicas(client, namespace, deployment, 1);
    }
    // For backup, do the equivalent of:
    // ssh knode6.lan -- sudo tar -C /var/lib/rancher/k3s/storage -c -j \
    //   -f - pvc-a24fabf7-9c28-4aa5-a4cf-6ac71
}

async function main() {
    const client = new Client({ version: '1.13' });
    let pvcs=await gatherPVCs(client, program.namespace);
    //console.log(JSON.stringify(pvcs, null, "  "));
    await doBackup(client, program.namespace, pvcs);
}

main();
