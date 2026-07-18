export const SAMPLE_YAML = `# Sample: realistic web-service pipeline
stages:
  - build
  - test
  - security
  - package
  - deploy

default:
  image: node:20-alpine
  tags: [docker]

variables:
  APP_NAME: storefront

.rules-mr-and-main:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - if: '$CI_COMMIT_BRANCH == "main"'

lint:
  stage: .pre
  script:
    - npm ci
    - npm run lint

compile:
  stage: build
  extends: .rules-mr-and-main
  script:
    - npm ci
    - npm run build
  artifacts:
    paths: [dist/]
    expire_in: 1 week

docs:
  stage: build
  script:
    - npm run docs
  artifacts:
    paths: [public/docs]
  when: manual
  allow_failure: true

unit-tests:
  stage: test
  needs: [compile]
  parallel: 4
  script:
    - npm run test:unit -- --shard $CI_NODE_INDEX/$CI_NODE_TOTAL
  coverage: '/Lines\\s*:\\s*(\\d+\\.?\\d*)%/'
  artifacts:
    reports:
      junit: junit.xml

integration-tests:
  stage: test
  needs: [compile]
  services:
    - postgres:16
    - redis:7
  variables:
    DATABASE_URL: postgres://postgres@postgres/app_test
  script:
    - npm run test:integration

e2e-tests:
  stage: test
  needs: [compile]
  image: mcr.microsoft.com/playwright:v1.44.0
  script:
    - npx playwright test
  allow_failure: true

sast:
  stage: security
  needs: []
  script:
    - /analyzer run

dependency-scan:
  stage: security
  needs: [compile]
  script:
    - npm audit --audit-level=high

docker-image:
  stage: package
  needs: [unit-tests, integration-tests]
  image: docker:26
  services: [docker:26-dind]
  script:
    - docker build -t $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA .
    - docker push $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA

helm-chart:
  stage: package
  needs: [unit-tests]
  image: alpine/helm:3
  script:
    - helm package chart/ --version 0.1.0-$CI_COMMIT_SHORT_SHA

deploy-staging:
  stage: deploy
  needs: [docker-image, helm-chart, dependency-scan]
  environment: staging
  script:
    - helm upgrade --install $APP_NAME ./chart -n staging

deploy-production:
  stage: deploy
  needs: [docker-image, helm-chart]
  environment: production
  when: manual
  resource_group: production
  script:
    - helm upgrade --install $APP_NAME ./chart -n production

notify:
  stage: .post
  script:
    - ./scripts/notify-slack.sh "$CI_PIPELINE_STATUS"
`;
