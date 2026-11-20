#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

source "${ROOT_DIR}/.envrc"

usage() {
    echo "Usage: $0 [build_and_push|deploy|undeploy] [pi|vm]"
    exit 1
}

build_and_push() {
    echo "==> Building multi-arch image: ${IMAGE_NAME}"
    cd "$ROOT_DIR"

    # Skip `docker login` — its daemon preflight ping to /v2/ gets a 403 from
    # Harbor/Cloudflare before credentials are used. BuildKit's push only needs
    # an auth config (the same challenge/token flow podman uses).
    export DOCKER_CONFIG="${DOCKER_CONFIG:-$PWD/.docker-harbor}"
    mkdir -p "$DOCKER_CONFIG"
    cat > "$DOCKER_CONFIG/config.json" <<EOF
{
  "auths": {
    "$HARBOR_REGISTRY_URL": {
      "auth": "$(printf '%s' "$HARBOR_USERNAME:$HARBOR_PASSWORD" | base64)"
    }
  }
}
EOF

    # Multi-arch buildx requires binfmt registration for cross-arch emulation.
    docker buildx create --use --name immigration-tracker-builder 2>/dev/null || docker buildx use immigration-tracker-builder
    docker run --privileged --rm tonistiigi/binfmt --install all

    SHA="${GITHUB_SHA:-$(git rev-parse --short HEAD)}"
    docker buildx build \
        --platform linux/amd64,linux/arm64 \
        --provenance=false \
        --tag "${HARBOR_REGISTRY_URL}/${HARBOR_PROJECT}/${IMAGE_NAME}:latest" \
        --tag "${HARBOR_REGISTRY_URL}/${HARBOR_PROJECT}/${IMAGE_NAME}:${SHA}" \
        --push .

    echo "==> Verifying pushed manifest"
    docker buildx imagetools inspect "${HARBOR_REGISTRY_URL}/${HARBOR_PROJECT}/${IMAGE_NAME}:latest" | tee /tmp/manifest.txt
    grep -q 'linux/amd64' /tmp/manifest.txt
    grep -q 'linux/arm64' /tmp/manifest.txt
    echo "✅ Multi-arch manifest contains both amd64 and arm64"
    echo "==> Done. Image pushed as :latest and :${SHA}"
}

deploy() {
    local platform="${1:-vm}"
    local context="kubernetes-admin-${platform}@kubernetes-${platform}"

    echo "==> Deploying ${SITE_NAME} to ${platform}"
    kubectl config use-context "$context"

    VERSION="${GITHUB_SHA:-$(git rev-parse --short HEAD)}"
    export VERSION

    if kubectl get deployment "${SITE_NAME}" &>/dev/null; then
        echo "==> Deployment exists, rolling restart"
        kubectl rollout restart deployment/"${SITE_NAME}"
    else
        echo "==> Creating new deployment"
        envsubst < "${SCRIPT_DIR}/deployment.yml" | kubectl apply -f -
    fi

    echo "==> Waiting for rollout (300s timeout)"
    kubectl rollout status deployment/"${SITE_NAME}" --timeout=300s
    echo "==> Deployed successfully"
}

undeploy() {
    local platform="${1:-vm}"
    local context="kubernetes-admin-${platform}@kubernetes-${platform}"

    echo "==> Undeploying ${SITE_NAME} from ${platform}"
    kubectl config use-context "$context"
    envsubst < "${SCRIPT_DIR}/deployment.yml" | kubectl delete -f - --ignore-not-found
    echo "==> Undeployed"
}

case "${1:-}" in
    build_and_push)
        build_and_push
        ;;
    deploy)
        deploy "${2:-vm}"
        ;;
    undeploy)
        undeploy "${2:-vm}"
        ;;
    *)
        usage
        ;;
esac
