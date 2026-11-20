#!/usr/bin/env bash
# Local replication of the workflow's "Generate VM deployment manifest" step.
# Usage: ci/local-manifest.sh <deployment-manifests-dir> <git-sha>
set -euo pipefail

DIR="${1:?usage: local-manifest.sh <deployment-manifests-dir> <git-sha>}"
SHA="${2:?usage: local-manifest.sh <deployment-manifests-dir> <git-sha>}"
cd "$(dirname "$0")/.."

# App config + registry credentials from keyring-backed .envrc.
set -a
source ./.envrc
set +a

# Platform is a GitHub-Action var in CI; the local deployment targets the VM.
export VERSION="${SHA}" PLATFORM="vm"

mkdir -p "${DIR}/vm"
envsubst < ci/deployment.yml > "${DIR}/vm/${IMAGE_NAME}-deployment.yaml"
echo ">>> generated ${DIR}/vm/${IMAGE_NAME}-deployment.yaml for version ${SHA}"
