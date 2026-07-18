export const SAMPLE_YAML = `# Sample: Java (Maven) microservice deployed to Kubernetes via Helm.
# A generic, textbook pipeline — build, test, quality gates, containerize,
# then progressive Helm rollouts across dev / staging / production.
stages:
  - build
  - test
  - quality
  - package
  - deploy
  - verify

default:
  image: maven:3.9-eclipse-temurin-21
  tags: [docker]
  interruptible: true

variables:
  APP_NAME: orders-api
  MAVEN_OPTS: "-Dmaven.repo.local=.m2/repository -Dstyle.color=always"
  HELM_CHART: ./deploy/chart
  IMAGE: \${CI_REGISTRY_IMAGE}:\${CI_COMMIT_SHORT_SHA}

# ---- reusable anchors -------------------------------------------------------

.maven-cache: &maven-cache
  key:
    files: [pom.xml]
  paths: [.m2/repository]
  policy: pull

# ---- reusable rule sets (hidden templates) ----------------------------------

.rules-mr-and-main:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'

.rules-default-only:
  rules:
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'

.rules-release-tag:
  rules:
    - if: '$CI_COMMIT_TAG =~ /^v\\d+\\.\\d+\\.\\d+$/'

# ---- reusable deploy template ------------------------------------------------

.deploy:
  image: alpine/helm:3.15
  tags: [docker]
  script:
    - helm upgrade --install $APP_NAME $HELM_CHART
      --namespace $KUBE_NAMESPACE --create-namespace
      --set image.repository=$CI_REGISTRY_IMAGE
      --set image.tag=$CI_COMMIT_SHORT_SHA
      --wait --timeout 5m

# ---- build ------------------------------------------------------------------

compile:
  stage: build
  extends: .rules-mr-and-main
  cache:
    <<: *maven-cache
    policy: pull-push
  script:
    - mvn -B clean compile
  artifacts:
    paths: [target/classes]
    expire_in: 1 day

# ---- test (fan-out from compile) --------------------------------------------

unit-tests:
  stage: test
  needs: [compile]
  cache: *maven-cache
  parallel:
    matrix:
      - JDK: ["17", "21"]
  image: maven:3.9-eclipse-temurin-\${JDK}
  script:
    - mvn -B test
  coverage: '/Total.*?([0-9]{1,3})%/'
  artifacts:
    reports:
      junit: target/surefire-reports/TEST-*.xml

integration-tests:
  stage: test
  needs: [compile]
  cache: *maven-cache
  services:
    - name: postgres:16
      alias: db
  variables:
    SPRING_DATASOURCE_URL: jdbc:postgresql://db:5432/orders
    POSTGRES_DB: orders
    POSTGRES_HOST_AUTH_METHOD: trust
  script:
    - mvn -B verify -Pintegration
  artifacts:
    reports:
      junit: target/failsafe-reports/TEST-*.xml

contract-tests:
  stage: test
  needs: [compile]
  cache: *maven-cache
  script:
    - mvn -B test -Pcontracts
  allow_failure: true

# ---- quality gates ----------------------------------------------------------

sast:
  stage: quality
  needs: []
  script:
    - /analyzer run

dependency-scan:
  stage: quality
  needs: [compile]
  cache: *maven-cache
  script:
    - mvn -B org.owasp:dependency-check-maven:check

sonarqube:
  stage: quality
  extends: .rules-mr-and-main
  needs: [unit-tests, integration-tests]
  cache: *maven-cache
  script:
    - mvn -B sonar:sonar -Dsonar.projectKey=$APP_NAME
  allow_failure: true

# ---- package (container image + helm chart) ---------------------------------

docker-image:
  stage: package
  needs: [unit-tests, integration-tests, dependency-scan]
  image:
    name: gcr.io/kaniko-project/executor:v1.23.0-debug
    entrypoint: [""]
  script:
    - /kaniko/executor
      --context $CI_PROJECT_DIR
      --dockerfile $CI_PROJECT_DIR/Dockerfile
      --destination $IMAGE
      --destination $CI_REGISTRY_IMAGE:latest
  rules:
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'
    - if: '$CI_COMMIT_TAG =~ /^v\\d+\\.\\d+\\.\\d+$/'

helm-package:
  stage: package
  needs: [contract-tests]
  image: alpine/helm:3.15
  script:
    - helm lint $HELM_CHART
    - helm package $HELM_CHART --version 0.1.0-$CI_COMMIT_SHORT_SHA
  artifacts:
    paths: ["*.tgz"]

# ---- deploy (progressive: dev -> staging -> production) ---------------------

deploy-dev:
  extends: .deploy
  stage: deploy
  needs: [docker-image, helm-package]
  variables:
    KUBE_NAMESPACE: orders-dev
  environment:
    name: dev
    url: https://dev.orders.example.com
  rules:
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'

deploy-staging:
  extends: .deploy
  stage: deploy
  needs: [deploy-dev]
  variables:
    KUBE_NAMESPACE: orders-staging
  environment:
    name: staging
    url: https://staging.orders.example.com
  rules:
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'
      when: manual

deploy-production:
  extends: [.deploy, .rules-release-tag]
  stage: deploy
  needs: [docker-image, helm-package]
  variables:
    KUBE_NAMESPACE: orders-prod
  environment:
    name: production
    url: https://orders.example.com
  resource_group: production

# ---- verify -----------------------------------------------------------------

smoke-test:
  stage: verify
  needs: [deploy-staging]
  image: curlimages/curl:8.8.0
  script:
    - curl -sf https://staging.orders.example.com/actuator/health

# Downstream end-to-end suite lives in its own project; trigger it after
# staging is live (cross-pipeline — drawn as a boundary, not an edge).
e2e-downstream:
  stage: verify
  needs: [deploy-staging]
  trigger:
    project: qa/orders-e2e
    branch: main
    strategy: depend

nightly-load-test:
  stage: verify
  image: grafana/k6:0.51.0
  script:
    - k6 run load/smoke.js
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule"'

# ---- housekeeping -----------------------------------------------------------

notify:
  stage: .post
  image: curlimages/curl:8.8.0
  script:
    - curl -sf -X POST "$SLACK_WEBHOOK" -d "{\\"text\\":\\"$APP_NAME $CI_PIPELINE_STATUS\\"}"
  when: always
`;
