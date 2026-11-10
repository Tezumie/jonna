# ACP agent registry snapshot

`registry.json` is a snapshot of the ACP agent registry, bundled so the agent gallery on the
Models page works offline and before the first fetch (D215). The IDE fetches the live file
(`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`) through its native side
when the gallery opens or on **Refresh the ACP agent registry**, keeps that copy in its data
folder, and falls back to this snapshot when it can't be reached.

**Source:** <https://github.com/agentclientprotocol/registry> (the commit is in the file's
`source.commit`), licensed Apache-2.0. Each agent's `agent.json` is copied with its `preview`
block dropped (the published registry.json drops it too), and its `icon.svg` is inlined as an
SVG data URL (whitespace collapsed; otherwise unaltered).

**Left out**, as the registry's own rules and the IDE's license policy say:

- agents in the registry's `quarantine.json` (broken at the time of the snapshot);
- agents whose own license is GPL, LGPL or AGPL (`corust-agent`, `minion-code`);
- icons with scripts, event handlers, external references, styles or `foreignObject` (none at
  the time of writing).

The metadata and icons describe third-party agents: their names and logos are their owners'
trademarks, shown to identify each agent. Several agents are proprietary (their `license` says
so); installing one downloads it from its publisher under its own terms, which the gallery shows
before anything is installed.

**Regenerate** from a clone (its files are read as data; nothing in it is run):

```sh
git clone --depth 1 https://github.com/agentclientprotocol/registry /tmp/acp-registry
node scripts/gen-acp-registry.mjs /tmp/acp-registry
npx biome format --write src/assets/acp-registry/registry.json
```

The registry's license:

```text
Apache License, Version 2.0, January 2004, http://www.apache.org/licenses/

Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except
in compliance with the License. You may obtain a copy of the License at
http://www.apache.org/licenses/LICENSE-2.0. Unless required by applicable law or agreed to in
writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific
language governing permissions and limitations under the License.
```
