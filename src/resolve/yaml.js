// GitLab YAML dialect: js-yaml schema extended with the `!reference` tag.

import yaml from "js-yaml";

export class GitlabRef {
  constructor(path) {
    this.path = path; // e.g. ['.job', 'script']
  }
  toString() {
    return `!reference [${this.path.join(", ")}]`;
  }
}

const REFERENCE_TYPE = new yaml.Type("!reference", {
  kind: "sequence",
  construct: (seq) => new GitlabRef((seq ?? []).map(String)),
});

const GITLAB_SCHEMA = yaml.DEFAULT_SCHEMA.extend([REFERENCE_TYPE]);

export function loadDocs(text) {
  return yaml.loadAll(text, { schema: GITLAB_SCHEMA }).filter((d) => d !== null && d !== undefined);
}
