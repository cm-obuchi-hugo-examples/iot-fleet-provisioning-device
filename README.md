# Minimal AWS IoT Fleet Provisioning device

A small Node.js 24 program that demonstrates the complete happy path:

```text
first run: claim certificate → register Thing → save production certificate → publish
later run: saved production certificate → skip registration → publish
```

All application logic is in `src/index.ts`.

## Important limitation

This minimal version is for learning and blog demonstration. It does not
recover safely if the process stops between AWS generating/registering the
certificate and the two production credential files being saved. A production
implementation should persist pending state and reconcile interrupted
provisioning attempts before requesting another certificate.

The program still:

- Never logs private keys or ownership tokens.
- Writes credential files atomically with mode `600`.
- Stops if only one production credential file exists.
- Reuses saved credentials after a normal successful first run.

## 1. Prepare claim files

From this directory, replace `<CERTIFICATE_ID>`:

```sh
mkdir -p ../certs/fleet-bootstrap
cp ../certs/<CERTIFICATE_ID>-certificate.pem.crt \
  ../certs/fleet-bootstrap/claim.pem.crt
cp ../certs/<CERTIFICATE_ID>-private.pem.key \
  ../certs/fleet-bootstrap/claim.private.pem.key
cp ../certs/AmazonRootCA1.pem \
  ../certs/fleet-bootstrap/AmazonRootCA1.pem
chmod 600 ../certs/fleet-bootstrap/claim.private.pem.key
```

## 2. Configure

```sh
cp .env.example .env
```

Edit `.env`:

- Set `AWS_IOT_ENDPOINT` to the enabled `iot:Data-ATS` domain name.
- Replace `REPLACE_WITH_TEMPLATE_PARAMETER` with the actual parameter from
  provisioning template version 1.

For example, only if the template expects `SerialNumber`:

```text
FLEET_TEMPLATE_PARAMETERS_JSON={"SerialNumber":"02"}
```

The template must return the final Thing name `lab-iot-machine-02`.

## 3. Build

```sh
corepack enable
pnpm install
pnpm typecheck
pnpm build
podman build -t iot-fleet-provisioning-device .
```

## 4. Prepare persistent device storage

```sh
mkdir -p ../fleet-volumes/lab-iot-machine-02
chmod 700 ../fleet-volumes/lab-iot-machine-02
```

## 5. First run

Subscribe in the AWS IoT MQTT test client to:

```text
factory/line-a/+/telemetry
```

Then run:

```sh
podman run --rm \
  --name lab-iot-machine-02 \
  --user "$(id -u):$(id -g)" \
  --env-file .env \
  -v "$(pwd)/../certs/fleet-bootstrap:/bootstrap:ro" \
  -v "$(pwd)/../certs/fleet-bootstrap/AmazonRootCA1.pem:/trust/AmazonRootCA1.pem:ro" \
  -v "$(pwd)/../fleet-volumes/lab-iot-machine-02:/identity:rw" \
  iot-fleet-provisioning-device
```

Expected:

```text
Provisioning lab-iot-machine-02 with the claim certificate...
Provisioned lab-iot-machine-02; production credentials saved.
Published one message to factory/line-a/lab-iot-machine-02/telemetry.
```

## 6. Restart test

The claim directory is no longer required. Keep the public root CA and saved
identity mounts:

```sh
podman run --rm \
  --name lab-iot-machine-02 \
  --user "$(id -u):$(id -g)" \
  --env-file .env \
  -v "$(pwd)/../certs/fleet-bootstrap/AmazonRootCA1.pem:/trust/AmazonRootCA1.pem:ro" \
  -v "$(pwd)/../fleet-volumes/lab-iot-machine-02:/identity:rw" \
  iot-fleet-provisioning-device
```

Expected:

```text
Existing production credentials found; skipping provisioning.
Published one message to factory/line-a/lab-iot-machine-02/telemetry.
```

