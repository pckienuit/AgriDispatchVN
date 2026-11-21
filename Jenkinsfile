// Jenkins build job for the B1 demo branch (job path agridispatch/cloud-demo-b1).
// Triggered by the Azure DevOps Build stage through server/scripts/jenkins-build.js with BUILD_SHA and PUBLISH.
// Jenkins global environment (set by the Jenkins admin, never by request parameters):
//   AGRI_REPO_URL          https clone URL of the repository
//   ACR_REGISTRY           ACR login server, *.azurecr.io (also embedded in build-manifest.json)
//   AZURE_SUBSCRIPTION_ID  Target Azure subscription UUID (required when PUBLISH is true; no fallback)
// Agent label agridispatch-azure-build provides: git, Docker with Compose v2.24+, Node 26, npm 11, openssl.
// az must already be logged in on the agent only when PUBLISH is true.
// Parallel builds are safe: every build owns a unique Compose project, external mktemp directory, and tmpfs test DB with no host port.
pipeline {
  agent { label 'agridispatch-azure-build' }
  options {
    skipDefaultCheckout(true)
    timeout(time: 60, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }
  parameters {
    string(name: 'BUILD_SHA', trim: false, description: 'Full lowercase 40-character commit SHA. Must be the current head of demo/cl05-b1.')
    booleanParam(name: 'PUBLISH', defaultValue: false, description: 'Push SHA-tagged images to ACR and record their digests. Off by default.')
  }
  environment {
    APPROVED_BRANCH = 'demo/cl05-b1'
    RESOURCE_GROUP = 'rg-is402-agri'
    BUILD_SHA = "${params.BUILD_SHA}"
    PUBLISH = "${params.PUBLISH}"
  }
  stages {
    stage('Validate request') {
      steps {
        script {
          if (!(params.BUILD_SHA ==~ /[0-9a-f]{40}/)) { error('BUILD_SHA must be a full lowercase 40-character SHA') }
          if (!env.AGRI_REPO_URL?.trim()) { error('AGRI_REPO_URL is not configured in Jenkins global properties') }
          if (!(env.ACR_REGISTRY ==~ /[a-z0-9]{5,50}\.azurecr\.io/)) { error('ACR_REGISTRY must be configured as an *.azurecr.io login server') }
          if (params.PUBLISH && !(env.AZURE_SUBSCRIPTION_ID ==~ /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/)) {
            error('AZURE_SUBSCRIPTION_ID UUID is required when PUBLISH is true')
          }
          env.CI_PROJECT = sh(returnStdout: true, script: 'printf "agri-ci-%s-%s" "$BUILD_NUMBER" "$(openssl rand -hex 4)"').trim()
          env.CI_EPH = sh(returnStdout: true, script: 'umask 077 && mktemp -d').trim()
        }
      }
    }
    stage('Preflight tools') {
      steps {
        sh '''
          set +x
          set -eu
          test "$(node -p 'process.versions.node.split(".")[0]')" = 26
          case "$(npm -v)" in 11.*) ;; *) echo "npm 11 required" >&2; exit 1 ;; esac
          docker version --format '{{.Server.Version}}' >/dev/null
          docker compose version >/dev/null
          openssl version >/dev/null
          git --version >/dev/null
          python3 -c 'import yaml' >/dev/null
        '''
      }
    }
    stage('Checkout approved SHA') {
      steps {
        deleteDir()
        sh '''
          set +x
          set -eu
          git init -q .
          git remote add origin "$AGRI_REPO_URL"
          git fetch --no-tags origin "+refs/heads/$APPROVED_BRANCH:refs/remotes/origin/$APPROVED_BRANCH"
          head=$(git rev-parse --verify "refs/remotes/origin/$APPROVED_BRANCH^{commit}")
          if [ "$head" != "$BUILD_SHA" ]; then
            echo "BUILD_SHA is not the current head of $APPROVED_BRANCH; rerun with the new head" >&2
            exit 1
          fi
          git checkout -q --detach "$BUILD_SHA"
          test "$(git rev-parse HEAD)" = "$BUILD_SHA"
        '''
      }
    }
    stage('Lint and unit') {
      steps {
        sh '''
          set +x
          set -eu
          npm ci
          npm run lint
          npm test
        '''
      }
    }
    stage('Integration on disposable DB') {
      steps {
        sh '''
          set +x
          set -eu
          umask 077
          test -n "${CI_EPH:-}" && test -d "$CI_EPH"
          ENVFILE="$CI_EPH/compose.env"
          OVERRIDE="$CI_EPH/no-host-ports.yml"
          printf 'POSTGRES_PASSWORD=%s\nINTERNAL_SERVICE_TOKEN=%s\n' "$(openssl rand -hex 16)" "$(openssl rand -hex 32)" > "$ENVFILE"
          cat > "$OVERRIDE" <<'YAML'
services:
  test-db:
    ports: !reset []
  test:
    network_mode: service:test-db
    environment:
      TEST_DATABASE_URL: postgresql://agridispatch:disposable_test_only@127.0.0.1:5432/agridispatch_test
YAML
          compose() {
            docker compose -p "$CI_PROJECT" --env-file "$ENVFILE" -f infra/compose.yaml -f "$OVERRIDE" --profile test "$@"
          }
          compose up -d --wait test-db
          compose run --rm test
        '''
      }
    }
    stage('Build images and Function test') {
      steps {
        sh '''
          set +x
          set -eu
          docker build -f infra/Dockerfile --build-arg BUILD_SHA="$BUILD_SHA" -t "agridispatch-vn:$CI_PROJECT" .
          docker build -f infra/Function.Dockerfile --build-arg BUILD_SHA="$BUILD_SHA" -t "agridispatch-thumbnail:$CI_PROJECT" .
          docker run --rm --entrypoint node "agridispatch-thumbnail:$CI_PROJECT" --test functions/thumbnail/processor.test.cjs functions/thumbnail/handler.test.cjs
        '''
      }
    }
    stage('Publish to ACR') {
      when { expression { params.PUBLISH } }
      steps {
        script {
          env.APP_DIGEST = sh(returnStdout: true, script: '''
            set +x
            set -eu
            test -n "${CI_EPH:-}" && test -d "$CI_EPH"
            export DOCKER_CONFIG="$CI_EPH/docker-config"
            mkdir -p "$DOCKER_CONFIG" && chmod 700 "$DOCKER_CONFIG"
            test -n "${AZURE_SUBSCRIPTION_ID:-}"
            test "$RESOURCE_GROUP" = "rg-is402-agri"
            ACR_NAME="${ACR_REGISTRY%.azurecr.io}"
            active_sub=$(az account show --query id --output tsv)
            test "$(printf '%s' "$active_sub" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$AZURE_SUBSCRIPTION_ID" | tr '[:upper:]' '[:lower:]')"
            expected_acr_id="/subscriptions/${active_sub}/resourceGroups/${RESOURCE_GROUP}/providers/Microsoft.ContainerRegistry/registries/${ACR_NAME}"
            actual_acr_id=$(az acr show --subscription "$AZURE_SUBSCRIPTION_ID" --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME" --query id --output tsv)
            test "$(printf '%s' "$actual_acr_id" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$expected_acr_id" | tr '[:upper:]' '[:lower:]')"
            test "$(az acr show --subscription "$AZURE_SUBSCRIPTION_ID" --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME" --query loginServer --output tsv)" = "$ACR_REGISTRY"
            az acr login --subscription "$AZURE_SUBSCRIPTION_ID" --name "$ACR_NAME" --output none >&2
            docker tag "agridispatch-vn:$CI_PROJECT" "$ACR_REGISTRY/agridispatch-vn:$BUILD_SHA"
            push_log=$(docker push "$ACR_REGISTRY/agridispatch-vn:$BUILD_SHA")
            digest=$(echo "$push_log" | grep -Eo 'sha256:[0-9a-f]{64}')
            test "$(echo "$digest" | grep -c .)" = 1
            registry_digest=$(az acr repository show --subscription "$AZURE_SUBSCRIPTION_ID" --name "$ACR_NAME" --image "agridispatch-vn:$BUILD_SHA" --query digest --output tsv)
            test "$registry_digest" = "$digest"
            printf '%s' "$digest"
          ''').trim()
          env.FUNCTION_DIGEST = sh(returnStdout: true, script: '''
            set +x
            set -eu
            test -n "${CI_EPH:-}" && test -d "$CI_EPH"
            export DOCKER_CONFIG="$CI_EPH/docker-config"
            ACR_NAME="${ACR_REGISTRY%.azurecr.io}"
            docker tag "agridispatch-thumbnail:$CI_PROJECT" "$ACR_REGISTRY/agridispatch-thumbnail:$BUILD_SHA"
            push_log=$(docker push "$ACR_REGISTRY/agridispatch-thumbnail:$BUILD_SHA")
            digest=$(echo "$push_log" | grep -Eo 'sha256:[0-9a-f]{64}')
            test "$(echo "$digest" | grep -c .)" = 1
            registry_digest=$(az acr repository show --subscription "$AZURE_SUBSCRIPTION_ID" --name "$ACR_NAME" --image "agridispatch-thumbnail:$BUILD_SHA" --query digest --output tsv)
            test "$registry_digest" = "$digest"
            printf '%s' "$digest"
          ''').trim()
        }
      }
    }
    stage('Write build manifest') {
      steps {
        sh '''
          set +x
          set -eu
          rm -f build-manifest.json
          node server/scripts/jenkins-build.js write-manifest build-manifest.json
        '''
      }
    }
  }
  post {
    always {
      archiveArtifacts artifacts: 'build-manifest.json', allowEmptyArchive: true
      script {
        if (env.CI_PROJECT) {
          sh '''
            set +x
            set -eu
            if [ -n "${CI_EPH:-}" ] && [ -f "$CI_EPH/compose.env" ]; then
              docker compose -p "$CI_PROJECT" --env-file "$CI_EPH/compose.env" -f infra/compose.yaml -f "$CI_EPH/no-host-ports.yml" --profile test down -v --remove-orphans
            fi
            left=$(docker ps -aq --filter "label=com.docker.compose.project=$CI_PROJECT")
            if [ -n "$left" ]; then echo "containers left behind for $CI_PROJECT" >&2; exit 1; fi
            if [ -n "${CI_EPH:-}" ] && [ -d "$CI_EPH/docker-config" ] && [ -n "${ACR_REGISTRY:-}" ]; then
              DOCKER_CONFIG="$CI_EPH/docker-config" docker logout "$ACR_REGISTRY" >/dev/null 2>&1 || true
            fi
            for image in "agridispatch-vn:$CI_PROJECT" "agridispatch-thumbnail:$CI_PROJECT"; do
              if docker image inspect "$image" >/dev/null 2>&1; then docker image rm "$image" >/dev/null; fi
            done
            if [ -n "${CI_EPH:-}" ] && [ -d "$CI_EPH" ]; then rm -rf "$CI_EPH"; fi
          '''
        }
      }
    }
  }
}
