# Backup of local-path provisioned PVCs

k3s has a neat local-path provider which is great for persistent storage. Since I experiment with my k3s setup, I wanted to have a simple backup method. In particular I want a clean backup of my Influx DB.

This is the result.

## Notes

This is not a general backup program. It's a solving a specific I had and thus serves more as an example how to do something similar.

- It shuts down the k8s deployment (replicas set to 0)
- It backs up the local-path PVCs
- It sets replicas back to 1

## Usage

```
❯ node ./pvc-backup.js --help
Usage: pvc-backup [OPTIONS]...

Options:
  -v, --version                output the version number
  -n, --namespace <namespace>  The namespace (default is "default") (default: "default")
  -w, --wait N                 Wait N seconds for the replica count to change (default is 10)
  -d, --debug                  Debug (default: false)
  -h, --help                   display help for command
```

## Example Run

```
❯ node ./pvc-backup.js
Running backup for influxdb-deployment and volume 0...

Running backup for grafana-deployment and volume 1...
Running backup for grafana-deployment and volume 2...
❯ ls -lh *.xz
-rw-r--r-- 1 harald users 656K Apr 25 13:40 grafana-lib-2021-04-25.tar.xz
-rw-r--r-- 1 harald users  200 Apr 25 13:40 grafana-log-2021-04-25.tar.xz
-rw-r--r-- 1 harald users 1.1G Apr 25 13:40 influxdb-data-2021-04-25.tar.xz
```

## Update History

The initial version used the very nice kubernetes-client module from GoDaddy but it's not updated for a year.
So I migrated to the official @kubernetes/client-node module.
