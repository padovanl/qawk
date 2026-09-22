/* The Qawk API, as data.
 *
 * Every endpoint the server really serves, with its parameters, its body and
 * what it answers. The reference pages and the code samples in five languages
 * are generated from this, so an endpoint that changes is changed once.
 *
 * auth:  'basic'  a user, or an API token as a bearer
 *        'device' a device: gateway or target token
 * perm:  the permission the handler requires (hawkBit's names) */

window.QAWK_API = {

  // ------------------------------------------------------------------ Qawk
  qawk: {
    id: 'qawk',
    title: 'Qawk API',
    base: 'https://qawk.example.com',
    prefix: '/qawk/v1',
    auth: 'basic',
    blurb: 'Everything Qawk adds to hawkBit: channels and the release pipeline, ' +
      'centres, systems and the orchestrator, users, roles, API tokens and the audit log. ' +
      'It never changes hawkBit\'s own API — it sits beside it under <code>/qawk/v1</code>.',
    groups: [

      { t: 'Server', eps: [
        { id: 'info', m: 'GET', p: '/qawk/v1/info', t: 'What this server is',
          d: 'Name, version, the hawkBit version it speaks, the tenant and the list of features. ' +
             'This is the only endpoint that needs no credentials: a console asks it first, to find ' +
             'out whether it is talking to Qawk or to a stock hawkBit, and shows only what the ' +
             'server supports.',
          auth: 'none',
          res: { 200: { d: 'The server describes itself.', ex: {
            name: 'Qawk', version: '0.1.0', api: 'v1', hawkbit: '1.1.0', tenant: 'DEFAULT',
            features: ['download-progress', 'fleets', 'users', 'tokens', 'audit', 'pipeline',
              'metrics', 'batch', 'deployments', 'systems', 'centres'] } } } }
      ] },

      { t: 'Channels', eps: [
        { id: 'fleets-list', m: 'GET', p: '/qawk/v1/fleets', t: 'List channels',
          d: 'Every channel with its release, how that release is going, and the one waiting for ' +
             'approval if there is one. <code>progress</code> counts only the devices that stand ' +
             'alone: the members that belong to a system are the orchestrator\'s, and are counted ' +
             'under <code>systems</code>.',
          perm: 'READ_TARGET',
          res: { 200: { d: 'The channels, by name.', ex: { total: 3, content: [ {
            id: 2, name: 'beta', description: 'the pilot centres', colour: '#d29922',
            rule: 'attribute.ring==beta', distributionSetId: 7, distributionSet: 'app:1.2.0',
            actionType: 'forced', upstreamId: 1, upstream: 'dev', temporary: false, autoPromote: false,
            gate: { minDevices: 20, minSuccess: 95, soakMinutes: 120, approvalRequired: false },
            wavePercent: 25, waveTimeoutMinutes: 60, errorThreshold: 5, freeze: null,
            members: 140, onRelease: 131, updating: 4, failed: 1, inSystems: 64,
            manifestId: 3, manifest: 'device-system-2.0',
            orchestrator: { maxParallel: 4, maxFailed: 1, byCentre: true, centres: ['c01', 'c02'] },
            release: { id: 44, status: 'active', distributionSet: 'app:1.2.0', from: 'dev' },
            pending: null,
            progress: { members: 76, onRelease: 67, active: 4, succeeded: 67, failed: 1 },
            systems: { deploymentId: 51, name: 'beta · device-system-2.0 · release 44',
              status: 'running', total: 16, counts: { pending: 8, running: 4, succeeded: 4 },
              centre: 'c02', byCentre: true } } ] } } } },

        { id: 'fleets-create', m: 'POST', p: '/qawk/v1/fleets', t: 'Create a channel',
          d: 'A channel with no <code>upstreamId</code> stands alone and is given releases ' +
             'directly. One with an upstream takes them only by promotion, through its gate.',
          perm: 'CREATE_TARGET',
          body: { name: 'beta', description: 'the pilot centres', colour: '#d29922',
            rule: 'attribute.ring==beta', upstreamId: 1, actionType: 'forced',
            gate: { minDevices: 20, minSuccess: 95, soakMinutes: 120, approvalRequired: false },
            wavePercent: 25, waveTimeoutMinutes: 60, errorThreshold: 5,
            orchestrator: { maxParallel: 4, maxFailed: 1, byCentre: true, centres: ['c01', 'c02'] } },
          bf: [
            ['name', 'string', 1, 'What it is called. Unique.'],
            ['rule', 'string', 0, 'A target query. Devices matching it <b>and in no channel yet</b> join by themselves — so a device registering for the first time lands in the right one from what it reports: <code>attribute.ring==beta</code>.'],
            ['upstreamId', 'integer', 0, 'The channel it takes releases from. Absent or <code>0</code>: it stands alone.'],
            ['actionType', 'string', 0, '<code>forced</code> (the default) or <code>soft</code>.'],
            ['temporary', 'boolean', 0, 'Devices lent to it remember where they came from and can be sent home. A centre is never put in a temporary channel.'],
            ['autoPromote', 'boolean', 0, 'Promote itself as soon as its gate opens, instead of waiting for someone to press promote.'],
            ['gate.minDevices', 'integer', 0, 'Devices of the upstream that must run the release.'],
            ['gate.minSuccess', 'integer', 0, 'Percentage of the upstream that must run it (0–100).'],
            ['gate.soakMinutes', 'integer', 0, 'Minutes the release must have been in the upstream.'],
            ['gate.approvalRequired', 'boolean', 0, 'A second person approves before it goes out. Never the person who asked.'],
            ['wavePercent', 'integer', 0, 'Share of the members given the release at a time. <code>0</code>: all at once.'],
            ['waveTimeoutMinutes', 'integer', 0, 'How long a wave may take before the next starts anyway.'],
            ['errorThreshold', 'integer', 0, 'Percentage of failures that halts the release.'],
            ['distributionSetId', 'integer', 0, 'Give it this release at once. Refused for a channel with an upstream.'],
            ['manifestId', 'integer', 0, 'The manifest that goes with that release, for the channel\'s systems.'],
            ['orchestrator.maxParallel', 'integer', 0, 'Systems taken at a time. Default <code>4</code>.'],
            ['orchestrator.maxFailed', 'integer', 0, 'Systems that may fail before the rest are left alone.'],
            ['orchestrator.byCentre', 'boolean', 0, 'One centre at a time: the next starts when every system of the last is done. Default <code>true</code>.'],
            ['orchestrator.centres', 'string[]', 0, 'The centres it takes, <b>in that order</b>. Empty: every centre of the channel, by name.']
          ],
          res: { 201: { d: 'The channel as it now stands.' }, 400: { d: 'A rule that does not parse, a gate out of range, an upstream that would loop.' } } },

        { id: 'fleets-get', m: 'GET', p: '/qawk/v1/fleets/{fleetId}', t: 'Read a channel',
          d: 'One channel, with everything the list gives.', perm: 'READ_TARGET',
          pp: [['fleetId', 'integer', 1, 'The channel.']],
          res: { 200: { d: 'The channel.' }, 404: { d: 'No such channel.' } } },

        { id: 'fleets-update', m: 'PUT', p: '/qawk/v1/fleets/{fleetId}', t: 'Change a channel, or release into it',
          d: 'Every field is optional: what is left out is left alone. Sending a ' +
             '<code>distributionSetId</code> different from the one it runs <b>is a release</b> — ' +
             'refused for a channel with an upstream, which takes releases by promotion. ' +
             'Sending <code>manifestId</code> alongside it sends the orchestrator after the ' +
             'channel\'s systems with the same release.',
          perm: 'UPDATE_TARGET',
          pp: [['fleetId', 'integer', 1, 'The channel.']],
          body: { distributionSetId: 9, manifestId: 3,
            orchestrator: { maxParallel: 4, maxFailed: 1, byCentre: true, centres: ['c01', 'c02'] } },
          res: { 200: { d: 'The channel as it now stands.' },
            409: { d: 'The channel is frozen.' },
            400: { d: 'It takes its releases from an upstream; or the set is incomplete, invalid or deleted.' } } },

        { id: 'fleets-delete', m: 'DELETE', p: '/qawk/v1/fleets/{fleetId}', t: 'Delete a channel',
          d: 'Its devices stay as they are, in no channel.', perm: 'DELETE_TARGET',
          pp: [['fleetId', 'integer', 1, 'The channel.']],
          res: { 204: { d: 'Gone.' } } },

        { id: 'fleets-targets', m: 'GET', p: '/qawk/v1/fleets/{fleetId}/targets', t: 'List a channel\'s devices',
          d: 'The members with what each runs, what it was given, and when it last called in.',
          perm: 'READ_TARGET',
          pp: [['fleetId', 'integer', 1, 'The channel.']],
          q: [['offset', 'integer', 0, 'Where the page starts. Default <code>0</code>.'],
              ['limit', 'integer', 0, 'How many. Default <code>50</code>.']],
          res: { 200: { d: 'A page of members.', ex: { total: 140, size: 2, content: [
            { controllerId: 'shop-beta-017', name: 'shop-beta-017', updateStatus: 'in_sync',
              installed: 'app:1.2.0', assigned: 'app:1.2.0', lastControllerRequestAt: 1758531200000,
              joinedAt: 1757000000000, home: null },
            { controllerId: 'shop-beta-018', name: 'shop-beta-018', updateStatus: 'pending',
              installed: 'app:1.1.0', assigned: 'app:1.2.0', lastControllerRequestAt: 1758531190000,
              joinedAt: 1757000000000, home: null } ] } } } },

        { id: 'fleets-add', m: 'PUT', p: '/qawk/v1/fleets/{fleetId}/targets', t: 'Put devices in a channel',
          d: 'By hand. A device whose <b>centre</b> is in a channel cannot be moved into another one ' +
             'that is not temporary — its centre would take it back within seconds — so move the ' +
             'centre instead, or lend the device to a temporary channel.',
          perm: 'UPDATE_TARGET',
          pp: [['fleetId', 'integer', 1, 'The channel.']],
          body: ['shop-beta-017', 'shop-beta-018'],
          res: { 204: { d: 'Done.' }, 400: { d: 'A device of a centre that is in another channel.' } } },

        { id: 'fleets-remove', m: 'DELETE', p: '/qawk/v1/fleets/{fleetId}/targets', t: 'Take devices out of a channel',
          d: 'They end up in no channel — until a channel rule adopts them again.',
          perm: 'UPDATE_TARGET',
          pp: [['fleetId', 'integer', 1, 'The channel.']],
          body: ['shop-beta-017'],
          res: { 204: { d: 'Done.' } } },

        { id: 'fleets-return', m: 'POST', p: '/qawk/v1/fleets/{fleetId}/return', t: 'Send lent devices home',
          d: 'Devices lent to a temporary channel go back to the channel they came from, and get ' +
             'that channel\'s release again. An empty body sends them all.',
          perm: 'UPDATE_TARGET',
          pp: [['fleetId', 'integer', 1, 'The temporary channel.']],
          body: { controllerIds: ['expo-demo-01'] },
          res: { 200: { d: 'How many went back, and how many had nowhere to go.',
            ex: { returned: 3, stayed: 1 } } } },

        { id: 'fleets-gate', m: 'GET', p: '/qawk/v1/fleets/{fleetId}/gate', t: 'Would a promotion pass?',
          d: 'Asks the gate without promoting anything, and answers line by line — a ✓ or a ✗ for ' +
             'each condition, so the console can show exactly what is missing. When the upstream\'s ' +
             'release carries a manifest, the orchestrator having finished with the upstream\'s ' +
             'systems is one of the conditions.',
          perm: 'READ_TARGET',
          pp: [['fleetId', 'integer', 1, 'The channel the release would enter.']],
          q: [['from', 'integer', 1, 'The channel it would come from.']],
          res: { 200: { d: 'Open or not, and why.', ex: { open: false, report:
            '✓ app:1.2.0 in beta is not halted\n✓ 131 devices of beta run app:1.2.0 (at least 20)\n' +
            '✓ 94% of beta runs it (at least 95%)\n✗ it has been in beta for 41 minutes (at least 120)\n' +
            '✓ the orchestrator took beta\'s systems with device-system-2.0: finished (16 of 16 systems updated)' } } } },

        { id: 'fleets-promote', m: 'POST', p: '/qawk/v1/fleets/{fleetId}/promote', t: 'Promote a release',
          d: '"prod gets what beta has." Through the gate, or past it with <code>force</code>, a ' +
             'reason and the <code>APPROVE_ROLLOUT</code> permission. Answers <code>202</code> when ' +
             'the channel asks for an approval: the release waits, and someone else approves it.',
          perm: 'UPDATE_TARGET',
          pp: [['fleetId', 'integer', 1, 'The channel the release enters.']],
          body: { from: 2, force: false, reason: '', orchestrator: true },
          bf: [
            ['from', 'integer', 1, 'The channel the release comes from. Must be this one\'s upstream.'],
            ['force', 'boolean', 0, 'Go past a closed gate. Needs <code>APPROVE_ROLLOUT</code> and a reason.'],
            ['reason', 'string', 0, 'Why the gate was forced. It goes in the release\'s history and the audit log.'],
            ['orchestrator', 'boolean', 0, 'Whether the release\'s manifest comes along, for the channel\'s systems. Default: yes.']
          ],
          res: { 200: { d: 'The release, active.' },
            202: { d: 'The release is waiting for approval.' },
            409: { d: 'The gate is closed, with the report; or the channel is frozen.' },
            403: { d: 'Forcing needs APPROVE_ROLLOUT.' } } },

        { id: 'fleets-resume', m: 'POST', p: '/qawk/v1/fleets/{fleetId}/resume', t: 'Resume a halted release',
          d: 'The failures that halted it are counted as seen: only <b>new</b> failures can halt it again.',
          perm: 'UPDATE_TARGET',
          pp: [['fleetId', 'integer', 1, 'The channel.']],
          res: { 200: { d: 'The channel.' }, 400: { d: 'It has no halted release.' } } },

        { id: 'fleets-freeze', m: 'PUT', p: '/qawk/v1/fleets/{fleetId}/freeze', t: 'Freeze a channel',
          d: 'No release reaches it while the freeze is on. A person can still assign a set through ' +
             'hawkBit\'s API — the audit log says who did. <code>from</code> and <code>until</code> ' +
             'may be left out: now, and for ever.',
          perm: 'UPDATE_TARGET',
          pp: [['fleetId', 'integer', 1, 'The channel.']],
          body: { reason: 'league night, no updates until Monday', from: null, until: 1759000000000 },
          res: { 200: { d: 'The channel, frozen.' }, 400: { d: 'A freeze needs a reason.' } } },

        { id: 'fleets-thaw', m: 'DELETE', p: '/qawk/v1/fleets/{fleetId}/freeze', t: 'Lift a freeze',
          d: 'Releases reach the channel again from the next tick.', perm: 'UPDATE_TARGET',
          pp: [['fleetId', 'integer', 1, 'The channel.']],
          res: { 200: { d: 'The channel.' } } }
      ] },

      { t: 'Releases', eps: [
        { id: 'releases-list', m: 'GET', p: '/qawk/v1/releases', t: 'List releases',
          d: 'Every channel\'s releases, newest first. <code>?status=waiting_for_approval</code> is ' +
             'the approval queue the console shows on its bell.',
          perm: 'READ_TARGET',
          q: [['status', 'string', 0, 'One of <code>active</code>, <code>waiting_for_approval</code>, <code>halted</code>, <code>completed</code>, <code>denied</code>, <code>superseded</code>.'],
              ['limit', 'integer', 0, 'At most 500. Default <code>100</code>.']],
          res: { 200: { d: 'The releases.', ex: { total: 1, content: [ {
            id: 44, fleetId: 3, fleet: 'prod', distributionSetId: 7, distributionSet: 'app:1.2.0',
            fromId: 2, from: 'beta', status: 'waiting_for_approval', forced: false, reason: '',
            gateReport: '✓ …', requestedBy: 'rm-1', requestedAt: 1758531200000,
            decidedBy: null, decidedAt: null, startedAt: null, finishedAt: null,
            waves: 0, lastWaveAt: null, manifestId: 3, manifest: 'device-system-2.0',
            systemDeploymentId: null } ] } } } },

        { id: 'releases-fleet', m: 'GET', p: '/qawk/v1/fleets/{fleetId}/releases', t: 'One channel\'s releases',
          d: 'The history of what this channel has run, and what it was asked to run.',
          perm: 'READ_TARGET',
          pp: [['fleetId', 'integer', 1, 'The channel.']],
          q: [['status', 'string', 0, 'Filter by status.'], ['limit', 'integer', 0, 'At most 500.']],
          res: { 200: { d: 'The releases.' } } },

        { id: 'releases-approve', m: 'POST', p: '/qawk/v1/releases/{releaseId}/approve', t: 'Approve a release',
          d: 'Four eyes: never the person who asked for it. On approval the release goes out at once ' +
             '— its set to the devices that stand alone, its manifest to the orchestrator.',
          perm: 'APPROVE_ROLLOUT',
          pp: [['releaseId', 'integer', 1, 'The release waiting for approval.']],
          body: { note: 'checked with the centre manager' },
          res: { 200: { d: 'The release, active.' },
            403: { d: 'You asked for it yourself.' },
            400: { d: 'It is not waiting for approval.' } } },

        { id: 'releases-deny', m: 'POST', p: '/qawk/v1/releases/{releaseId}/deny', t: 'Deny a release',
          d: 'It never goes out. The note stays in the history.', perm: 'APPROVE_ROLLOUT',
          pp: [['releaseId', 'integer', 1, 'The release.']],
          body: { note: 'wait for the fix in 1.2.1' },
          res: { 200: { d: 'The release, denied.' } } }
      ] },

      { t: 'Centres', eps: [
        { id: 'centres-list', m: 'GET', p: '/qawk/v1/centres', t: 'List centres',
          d: 'Every centre the devices report, its channel, how many devices it has and how many of ' +
             'them are already in that channel. <code>field</code> is where the devices say it.',
          perm: 'READ_TARGET',
          res: { 200: { d: 'The centres.', ex: { field: 'attribute.centerid', total: 2, content: [
            { centre: 'c01', name: 'Bologna', fleetId: 2, fleet: 'beta', colour: '#d29922',
              devices: 64, onChannel: 64 },
            { centre: 'c03', name: 'Madrid', fleetId: 3, fleet: 'prod', colour: '#3fb950',
              devices: 58, onChannel: 51 } ] } } } },

        { id: 'centres-set', m: 'PUT', p: '/qawk/v1/centres', t: 'Put centres in a channel',
          d: 'Every device of those centres follows, a hundred at a time — the lane computers with ' +
             'their terminals, and the machines that stand alone alike. <code>fleetId</code> ' +
             '<code>null</code> or <code>0</code> takes them out of any channel. A temporary channel ' +
             'is refused: a centre is moved, a single device is lent.',
          perm: 'UPDATE_TARGET',
          body: { centres: ['c03', 'c04'], fleetId: 3 },
          res: { 200: { d: 'The centres, as the list gives them.' },
            400: { d: 'No centre named, no such channel, or a temporary one.' } } },

        { id: 'centres-settings', m: 'PUT', p: '/qawk/v1/centres/settings', t: 'Where devices say their centre',
          d: 'An <code>attribute.&lt;key&gt;</code> the device reports, or a ' +
             '<code>metadata.&lt;key&gt;</code> set from the console. The default is ' +
             '<code>attribute.centerid</code>.',
          perm: 'UPDATE_TARGET',
          body: { field: 'attribute.centerid' },
          res: { 200: { d: 'The centres, read through the new field.' } } }
      ] },

      { t: 'Orchestrator: system types', eps: [
        { id: 'st-list', m: 'GET', p: '/qawk/v1/systemtypes', t: 'List system types',
          d: 'Mender calls this a <b>topology</b>: the components a kind of system has, each a query ' +
             'that recognises its devices, and the field a device carries to say which system it is in.',
          perm: 'READ_TARGET',
          res: { 200: { d: 'The types.', ex: { total: 1, content: [ {
            id: 1, name: 'device-system', description: 'a lane computer with its terminals',
            systemKey: 'attribute.device', groupKey: 'attribute.centerid',
            components: [
              { componentType: 'device1', match: 'attribute.device_type==device1' },
              { componentType: 'device2', match: 'attribute.device_type==device2' },
              { componentType: 'device3', match: 'attribute.device_type==device3' } ],
            createdAt: 1757000000000, createdBy: 'admin' } ] } } } },

        { id: 'st-create', m: 'POST', p: '/qawk/v1/systemtypes', t: 'Create a system type',
          perm: 'CREATE_TARGET',
          d: 'Every component needs a name of its own and a query that says which devices it is.',
          body: { name: 'device-system', description: 'a lane computer with its terminals',
            systemKey: 'attribute.device', groupKey: 'attribute.centerid',
            components: [
              { componentType: 'device1', match: 'attribute.device_type==device1' },
              { componentType: 'device2', match: 'attribute.device_type==device2' } ] },
          bf: [
            ['name', 'string', 1, 'What the type is called. Unique.'],
            ['systemKey', 'string', 1, '<code>attribute.&lt;key&gt;</code> or <code>metadata.&lt;key&gt;</code>. <b>Every value of this field is one system.</b>'],
            ['groupKey', 'string', 0, 'The same, saying which centre a system is in. Left out: the centre field from the settings.'],
            ['components[].componentType', 'string', 1, 'The component\'s name, as a manifest names it.'],
            ['components[].match', 'string', 1, 'A target query recognising its devices: <code>attribute.device_type==device2</code>.']
          ],
          res: { 201: { d: 'The type.' }, 400: { d: 'A key that is not attribute./metadata., a component with no query, a query that does not parse.' } } },

        { id: 'st-get', m: 'GET', p: '/qawk/v1/systemtypes/{tid}', t: 'Read a system type',
          perm: 'READ_TARGET', pp: [['tid', 'integer', 1, 'The type.']],
          res: { 200: { d: 'The type.' } } },

        { id: 'st-update', m: 'PUT', p: '/qawk/v1/systemtypes/{tid}', t: 'Change a system type',
          d: 'The components sent replace the ones it had. Who belongs to a system is worked out ' +
             'again at once, so the channels stop delivering to the devices that just became part of one.',
          perm: 'UPDATE_TARGET', pp: [['tid', 'integer', 1, 'The type.']],
          res: { 200: { d: 'The type.' } } },

        { id: 'st-delete', m: 'DELETE', p: '/qawk/v1/systemtypes/{tid}', t: 'Delete a system type',
          d: 'Its manifests go with it. The devices are untouched.',
          perm: 'DELETE_TARGET', pp: [['tid', 'integer', 1, 'The type.']],
          res: { 204: { d: 'Gone.' } } },

        { id: 'st-systems', m: 'GET', p: '/qawk/v1/systemtypes/{tid}/systems', t: 'List the systems found',
          d: 'Not a table of systems — <b>what the devices say</b>. Every value of the type\'s key ' +
             'among the devices of its components is one system, with its centre (what most of its ' +
             'devices say) and its channel. <code>mixed</code> means its devices are not all in the ' +
             'same channel: the orchestrator leaves such a system alone until they are.',
          perm: 'READ_TARGET', pp: [['tid', 'integer', 1, 'The type.']],
          res: { 200: { d: 'The systems.', ex: { total: 2, content: [
            { system: 'device-07', devices: 4, components: { device1: 1, device2: 2, device3: 1 },
              group: 'c01', fleetId: 2, fleet: 'beta', colour: '#d29922', mixed: false },
            { system: 'device-08', devices: 4, components: { device1: 1, device2: 2, device3: 1 },
              group: 'c01', fleetId: null, fleet: null, colour: null, mixed: true } ] } } } },

        { id: 'st-import', m: 'POST', p: '/qawk/v1/systemtypes/import', t: 'Import a Mender topology',
          d: 'Mender\'s topology YAML, with two extra keys Qawk needs: ' +
             '<code>qawk_system_key</code> and, per component, <code>qawk_match</code>. Importing a ' +
             'topology whose <code>system_type</code> already exists updates it.',
          perm: 'CREATE_TARGET', ctype: 'application/yaml',
          raw: 'api_version: mender/v1\nkind: topology\nsystem_type: device-system\n' +
               'qawk_system_key: attribute.device\nqawk_group_key: attribute.centerid\ncomponents:\n' +
               '  - component_type: device1\n    qawk_match: attribute.device_type==device1\n' +
               '  - component_type: device2\n    qawk_match: attribute.device_type==device2\n',
          res: { 200: { d: 'The type, created or updated.' } } },

        { id: 'st-export', m: 'GET', p: '/qawk/v1/systemtypes/{tid}/topology.yaml', t: 'Export a topology',
          d: 'The same YAML back, as a download.', perm: 'READ_TARGET',
          pp: [['tid', 'integer', 1, 'The type.']],
          res: { 200: { d: 'A YAML attachment.' } } }
      ] },

      { t: 'Orchestrator: manifests', eps: [
        { id: 'mf-list', m: 'GET', p: '/qawk/v1/manifests', t: 'List manifests',
          d: 'A manifest is the state a system type should reach: for each component a distribution ' +
             'set and an <b>order</b>. Lower goes first; equal orders go together.',
          perm: 'READ_ROLLOUT',
          res: { 200: { d: 'The manifests.', ex: { total: 1, content: [ {
            id: 3, name: 'device-system-2.0', systemTypeId: 1, systemType: 'device-system',
            components: [
              { componentType: 'device2', distributionSetId: 11, distributionSet: 'device2-fw:2.0', order: 1 },
              { componentType: 'device3', distributionSetId: 12, distributionSet: 'device3-fw:2.0', order: 1 },
              { componentType: 'device1', distributionSetId: 10, distributionSet: 'app:2.0', order: 2 } ],
            createdAt: 1757100000000, createdBy: 'admin' } ] } } } },

        { id: 'mf-create', m: 'POST', p: '/qawk/v1/manifests', t: 'Create a manifest',
          perm: 'CREATE_ROLLOUT',
          d: 'Every component must be one the system type has, named once, with an order from 1 to 1000.',
          body: { name: 'device-system-2.0', systemTypeId: 1, components: [
            { componentType: 'device2', distributionSetId: 11, order: 1 },
            { componentType: 'device3', distributionSetId: 12, order: 1 },
            { componentType: 'device1', distributionSetId: 10, order: 2 } ] },
          bf: [
            ['name', 'string', 1, 'Unique.'],
            ['systemTypeId', 'integer', 1, 'The type this manifest is for.'],
            ['components[].componentType', 'string', 1, 'A component of that type.'],
            ['components[].distributionSetId', 'integer', 1, 'What that component should run.'],
            ['components[].order', 'integer', 1, '1 to 1000. <b>Lower goes first, equal together</b> — the terminals before the lane computer.']
          ],
          res: { 201: { d: 'The manifest.' }, 400: { d: 'A component the type has not, an order out of range, a set that does not exist.' } } },

        { id: 'mf-get', m: 'GET', p: '/qawk/v1/manifests/{mid}', t: 'Read a manifest',
          perm: 'READ_ROLLOUT', pp: [['mid', 'integer', 1, 'The manifest.']],
          res: { 200: { d: 'The manifest.' } } },
        { id: 'mf-update', m: 'PUT', p: '/qawk/v1/manifests/{mid}', t: 'Change a manifest',
          perm: 'UPDATE_ROLLOUT', pp: [['mid', 'integer', 1, 'The manifest.']],
          res: { 200: { d: 'The manifest.' } } },
        { id: 'mf-delete', m: 'DELETE', p: '/qawk/v1/manifests/{mid}', t: 'Delete a manifest',
          perm: 'DELETE_ROLLOUT', pp: [['mid', 'integer', 1, 'The manifest.']],
          res: { 204: { d: 'Gone.' } } },

        { id: 'mf-import', m: 'POST', p: '/qawk/v1/manifests/import', t: 'Import a Mender manifest',
          d: 'Mender\'s manifest YAML. <code>artifact_name</code> is a distribution set, ' +
             '<code>name:version</code> — or a name alone for its newest version. A component with ' +
             'no <code>update_strategy</code> goes in the first order. Importing the same manifest ' +
             'again updates it.',
          perm: 'CREATE_ROLLOUT', ctype: 'application/yaml',
          raw: 'api_version: mender/v1\nkind: manifest\nname: device-system-2.0\n' +
               'system_types_compatible:\n  - device-system\ncomponent_types:\n' +
               '  device2:\n    artifact_name: device2-fw:2.0\n    update_strategy:\n      order: 1\n' +
               '  device3:\n    artifact_name: device3-fw:2.0\n    update_strategy:\n      order: 1\n' +
               '  device1:\n    artifact_name: app:2.0\n    update_strategy:\n      order: 2\n',
          res: { 201: { d: 'The manifest, created.' }, 200: { d: 'The manifest, updated.' },
            400: { d: 'No such system type — import its topology first — or a set that is not there.' } } },

        { id: 'mf-export', m: 'GET', p: '/qawk/v1/manifests/{mid}/manifest.yaml', t: 'Export a manifest',
          perm: 'READ_ROLLOUT', pp: [['mid', 'integer', 1, 'The manifest.']],
          res: { 200: { d: 'A YAML attachment.' } } }
      ] },

      { t: 'Orchestrator: deployments', eps: [
        { id: 'sd-list', m: 'GET', p: '/qawk/v1/systemdeployments', t: 'List system deployments',
          d: 'A system deployment applies a manifest to systems, a few at a time. Newest first.',
          perm: 'READ_ROLLOUT',
          res: { 200: { d: 'The deployments, without their runs.', ex: { total: 1, content: [ {
            id: 51, name: 'beta · device-system-2.0 · release 44', manifestId: 3,
            manifest: 'device-system-2.0', systems: null, fleetId: 2, fleet: 'beta',
            groups: ['c01', 'c02'], maxParallel: 4, maxFailed: 1, actionType: 'forced',
            status: 'running', reason: '', startedBy: 'rm-1', startedAt: 1758531200000,
            finishedAt: null, total: 16, byCentre: true,
            counts: { pending: 8, running: 4, succeeded: 4, rolling_back: 0, rolled_back: 0, skipped: 0 }
          } ] } } } },

        { id: 'sd-create', m: 'POST', p: '/qawk/v1/systemdeployments', t: 'Create a system deployment',
          d: 'Created as a <b>draft</b>: nothing moves until you start it. Left to itself it takes ' +
             'every system of the manifest\'s type; <code>fleetId</code> keeps it to one channel, ' +
             '<code>groups</code> to some centres, <code>systems</code> to the ones you name.',
          perm: 'CREATE_ROLLOUT',
          body: { name: 'prod 2.0, first wave', manifestId: 3, fleetId: 3,
            groups: ['c03', 'c04'], maxParallel: 4, maxFailed: 1, actionType: 'forced', byCentre: true },
          bf: [
            ['name', 'string', 1, 'Unique.'],
            ['manifestId', 'integer', 1, 'What the systems should reach.'],
            ['fleetId', 'integer', 0, 'Only systems whose devices are <b>all</b> in this channel.'],
            ['groups', 'string[]', 0, 'Only these centres, <b>in this order</b>. Empty: every centre, by name.'],
            ['systems', 'string[]', 0, 'Only these systems, by the value of the type\'s key. Empty: all in scope.'],
            ['maxParallel', 'integer', 0, 'Systems under way at a time. Default <code>1</code>.'],
            ['maxFailed', 'integer', 0, 'Systems that may fail and be rolled back before no new one is started. Default <code>0</code>.'],
            ['actionType', 'string', 0, '<code>forced</code> (the default) or <code>soft</code>.'],
            ['byCentre', 'boolean', 0, 'One centre at a time: the next starts once every system of the last is done.']
          ],
          res: { 201: { d: 'The deployment, a draft, with its runs.' } } },

        { id: 'sd-get', m: 'GET', p: '/qawk/v1/systemdeployments/{did}', t: 'Read a system deployment',
          d: 'With every run: one per system, its centre, which order it is on, and how each ' +
             'component is going — how many of its devices run the manifest\'s set, and how many ' +
             'were put back.',
          perm: 'READ_ROLLOUT', pp: [['did', 'integer', 1, 'The deployment.']],
          res: { 200: { d: 'The deployment and its runs.', ex: { id: 51, status: 'running', total: 16,
            runs: [ { id: 700, system: 'device-07', centre: 'c01', status: 'running', currentOrder: 2,
              reason: '', startedAt: 1758531205000, finishedAt: null, components: [
                { componentType: 'device2', order: 1, devices: 2, onSet: 2, back: 0 },
                { componentType: 'device3', order: 1, devices: 1, onSet: 1, back: 0 },
                { componentType: 'device1', order: 2, devices: 1, onSet: 0, back: 0 } ] } ] } } } },

        { id: 'sd-delete', m: 'DELETE', p: '/qawk/v1/systemdeployments/{did}', t: 'Delete a system deployment',
          d: 'Only one that is not running or paused: abort it first.',
          perm: 'DELETE_ROLLOUT', pp: [['did', 'integer', 1, 'The deployment.']],
          res: { 204: { d: 'Gone.' }, 409: { d: 'It is running or paused.' } } },

        { id: 'sd-start', m: 'POST', p: '/qawk/v1/systemdeployments/{did}/start', t: 'Start it',
          d: 'Works out which systems it takes, in centre order, and begins. A draft only.',
          perm: 'HANDLE_ROLLOUT', pp: [['did', 'integer', 1, 'The deployment.']],
          res: { 200: { d: 'Running.' },
            409: { d: 'It is not a draft.' },
            400: { d: 'No system in scope has any device yet, or a set in the manifest cannot be assigned.' } } },

        { id: 'sd-pause', m: 'POST', p: '/qawk/v1/systemdeployments/{did}/pause', t: 'Pause it',
          d: 'The engine stops following it. Devices already sent a set finish what they were given.',
          perm: 'HANDLE_ROLLOUT', pp: [['did', 'integer', 1, 'The deployment.']],
          res: { 200: { d: 'Paused.' } } },

        { id: 'sd-resume', m: 'POST', p: '/qawk/v1/systemdeployments/{did}/resume', t: 'Resume it',
          perm: 'HANDLE_ROLLOUT', pp: [['did', 'integer', 1, 'The deployment.']],
          res: { 200: { d: 'Running.' } } },

        { id: 'sd-abort', m: 'POST', p: '/qawk/v1/systemdeployments/{did}/abort', t: 'Abort it',
          d: 'Systems not yet started are skipped. Systems under way are left to finish — aborting ' +
             'does not tear a half-updated system apart; roll it back if that is what you want.',
          perm: 'HANDLE_ROLLOUT', pp: [['did', 'integer', 1, 'The deployment.']],
          body: { reason: 'wrong manifest' },
          res: { 200: { d: 'Aborted.' } } },

        { id: 'sd-rollback', m: 'POST', p: '/qawk/v1/systemdeployments/{did}/runs/{rid}/rollback',
          t: 'Roll one system back',
          d: 'By hand, for a system that is running or has finished. Every device of it the ' +
             'deployment updated is given again the set it ran before. A device that ran nothing ' +
             'before is left as it is.',
          perm: 'HANDLE_ROLLOUT',
          pp: [['did', 'integer', 1, 'The deployment.'], ['rid', 'integer', 1, 'The run — one system.']],
          body: { reason: 'the lane is not scoring' },
          res: { 200: { d: 'The deployment, with that run rolling back.' },
            409: { d: 'That system is not running or finished.' } } }
      ] },

      { t: 'Devices at a glance', eps: [
        { id: 'tgt-state', m: 'GET', p: '/qawk/v1/targets/state', t: 'What devices are doing',
          d: 'One request for a page of devices: what each runs, what it was given, its open action ' +
             'and its channel — so a table of five hundred rows is one call, not five hundred.',
          perm: 'READ_TARGET',
          q: [['ids', 'string', 1, 'Controller ids, comma separated.']],
          res: { 200: { d: 'The state of each.' } } },

        { id: 'tgt-attrs', m: 'GET', p: '/qawk/v1/targets/attributes', t: 'Attributes of many devices',
          perm: 'READ_TARGET',
          q: [['ids', 'string', 1, 'Controller ids, comma separated.']],
          res: { 200: { d: 'The attributes of each.' } } },

        { id: 'deployments', m: 'GET', p: '/qawk/v1/deployments', t: 'Deployments under way',
          d: 'Every open action across the fleet, with the device, the set and where it has got to.',
          perm: 'READ_TARGET',
          res: { 200: { d: 'The open deployments.' } } },

        { id: 'downloads', m: 'GET', p: '/qawk/v1/downloads', t: 'Downloads in progress',
          d: 'Bytes so far against the artifact\'s size, per device — the progress bars in the ' +
             'console. A ranged download has no percentage: the device asks for the parts it wants.',
          perm: 'READ_TARGET',
          res: { 200: { d: 'The downloads.', ex: { total: 1, content: [ {
            actionId: 9120, controllerId: 'shop-prod-017', artifactId: 55, filename: 'app-1.2.0.swu',
            size: 41943040, bytes: 22020096, ranged: false, percent: 52,
            startedAt: 1758531200000, updatedAt: 1758531214000, completedAt: null } ] } } } },

        { id: 'action-downloads', m: 'GET', p: '/qawk/v1/actions/{actionId}/downloads',
          t: 'Downloads of one action', perm: 'READ_TARGET',
          pp: [['actionId', 'integer', 1, 'The action.']],
          res: { 200: { d: 'Its downloads.' } } }
      ] },

      { t: 'Users, roles and tokens', eps: [
        { id: 'me', m: 'GET', p: '/qawk/v1/me', t: 'Who am I',
          d: 'The signed-in user, their roles and what they may do. The console asks this to decide ' +
             'which buttons to draw.',
          res: { 200: { d: 'You.', ex: { username: 'rm-1', displayName: 'Release manager',
            roles: ['release-manager'], permissions: ['READ_TARGET', 'UPDATE_TARGET', 'APPROVE_ROLLOUT'],
            admin: false } } } },
        { id: 'me-password', m: 'PUT', p: '/qawk/v1/me/password', t: 'Change my password',
          body: { current: 'the-old-one', password: 'at-least-eight-characters' },
          res: { 204: { d: 'Changed.' }, 400: { d: 'The current password is wrong, or the new one is under 8 characters.' } } },
        { id: 'permissions', m: 'GET', p: '/qawk/v1/permissions', t: 'Every permission there is',
          d: 'hawkBit\'s permission names, for building a role.',
          res: { 200: { d: 'The permissions.' } } },
        { id: 'tokens-list', m: 'GET', p: '/qawk/v1/tokens', t: 'List my API tokens',
          res: { 200: { d: 'The tokens — never their secret.' } } },
        { id: 'tokens-create', m: 'POST', p: '/qawk/v1/tokens', t: 'Create an API token',
          d: 'Shown <b>once</b>. A token acts with its owner\'s permissions at the time it is used.',
          body: { name: 'ci', expiresInDays: 90 },
          res: { 201: { d: 'The token, with its secret.', ex: { id: 4, name: 'ci',
            token: 'qawk_9f3c…', createdAt: 1758531200000, expiresAt: 1766307200000 } } } },
        { id: 'tokens-revoke', m: 'DELETE', p: '/qawk/v1/tokens/{tokenId}', t: 'Revoke a token',
          pp: [['tokenId', 'integer', 1, 'The token.']],
          res: { 204: { d: 'Gone, at once.' } } },
        { id: 'users-list', m: 'GET', p: '/qawk/v1/users', t: 'List users', perm: 'READ_TARGET',
          res: { 200: { d: 'The users.' } } },
        { id: 'users-create', m: 'POST', p: '/qawk/v1/users', t: 'Create a user',
          perm: 'admin',
          body: { username: 'rm-1', password: 'at-least-8-chars', displayName: 'Release manager',
            roles: ['release-manager'] },
          res: { 201: { d: 'The user.' }, 400: { d: 'A password under 8 characters, or an unknown role.' } } },
        { id: 'users-get', m: 'GET', p: '/qawk/v1/users/{userId}', t: 'Read a user',
          pp: [['userId', 'integer', 1, 'The user.']], res: { 200: { d: 'The user.' } } },
        { id: 'users-update', m: 'PUT', p: '/qawk/v1/users/{userId}', t: 'Change a user',
          perm: 'admin', pp: [['userId', 'integer', 1, 'The user.']],
          body: { displayName: 'Release manager', roles: ['release-manager'], enabled: true },
          res: { 200: { d: 'The user.' } } },
        { id: 'users-delete', m: 'DELETE', p: '/qawk/v1/users/{userId}', t: 'Delete a user',
          perm: 'admin', pp: [['userId', 'integer', 1, 'The user.']], res: { 204: { d: 'Gone.' } } },
        { id: 'users-password', m: 'PUT', p: '/qawk/v1/users/{userId}/password', t: 'Set a user\'s password',
          perm: 'admin', pp: [['userId', 'integer', 1, 'The user.']],
          body: { password: 'at-least-8-chars' }, res: { 204: { d: 'Set.' } } },
        { id: 'roles-list', m: 'GET', p: '/qawk/v1/roles', t: 'List roles',
          d: 'The built-in roles — <code>admin</code>, <code>operator</code>, ' +
             '<code>release-manager</code>, <code>viewer</code> — and any of your own.',
          res: { 200: { d: 'The roles.' } } },
        { id: 'roles-create', m: 'POST', p: '/qawk/v1/roles', t: 'Create a role', perm: 'admin',
          body: { name: 'centre-manager', description: 'moves centres between channels',
            permissions: ['READ_TARGET', 'UPDATE_TARGET'] },
          res: { 201: { d: 'The role.' } } },
        { id: 'roles-update', m: 'PUT', p: '/qawk/v1/roles/{name}', t: 'Change a role', perm: 'admin',
          pp: [['name', 'string', 1, 'The role. A built-in one cannot be changed.']],
          res: { 200: { d: 'The role.' } } },
        { id: 'roles-delete', m: 'DELETE', p: '/qawk/v1/roles/{name}', t: 'Delete a role', perm: 'admin',
          pp: [['name', 'string', 1, 'The role.']], res: { 204: { d: 'Gone.' } } },
        { id: 'audit', m: 'GET', p: '/qawk/v1/audit', t: 'The audit log',
          d: 'Every change and every refused sign-in: who, what, when, from where. Kept for ' +
             '<code>QAWK_AUDIT_DAYS</code> days.',
          perm: 'admin',
          q: [['all', 'boolean', 0, '<code>true</code>: everyone\'s. Otherwise your own.'],
              ['offset', 'integer', 0, 'Where the page starts.'],
              ['limit', 'integer', 0, 'How many.']],
          res: { 200: { d: 'A page of entries.' } } }
      ] }
    ]
  },

  // ------------------------------------------------------------------- DDI
  ddi: {
    id: 'ddi',
    title: 'Device API (DDI)',
    base: 'https://qawk.example.com',
    prefix: '/DEFAULT/controller/v1/{controllerId}',
    auth: 'device',
    blurb: 'hawkBit\'s <b>Direct Device Integration</b> API, exactly as hawkBit 1.1.0 serves it — ' +
      'all sixteen operations, the same JSON, the same status codes, the same download headers. ' +
      'A device that updates from hawkBit updates from Qawk with no change at all: point it at a ' +
      'different host. This is what SWUpdate\'s <i>suricatta</i> speaks.',
    note: 'A device authenticates with a <b>gateway token</b> (<code>Authorization: GatewayToken ' +
      '&lt;key&gt;</code>) or its own <b>target token</b> (<code>Authorization: TargetToken ' +
      '&lt;key&gt;</code>). With gateway tokens enabled, a device that has never been seen registers ' +
      'itself at its first poll.',
    groups: [
      { t: 'Polling', eps: [
        { id: 'ddi-base', m: 'GET', p: '/{tenant}/controller/v1/{controllerId}', t: 'Poll',
          auth: 'device',
          d: 'The device asks "anything for me?". The answer carries <code>config.polling.sleep</code> ' +
             '— how long to wait before asking again — and, when there is work, a link under ' +
             '<code>_links</code>: <code>deploymentBase</code> for an update, ' +
             '<code>cancelAction</code> for one to stop, <code>configData</code> when Qawk wants the ' +
             'device to say what it is.',
          pp: [['tenant', 'string', 1, 'The tenant. <code>DEFAULT</code> unless <code>QAWK_TENANT</code> says otherwise.'],
               ['controllerId', 'string', 1, 'The device\'s id — what SWUpdate calls <code>id</code>.']],
          res: { 200: { d: 'What to do next.', ex: {
            config: { polling: { sleep: '00:05:00' } },
            _links: { deploymentBase: { href: 'https://qawk.example.com/DEFAULT/controller/v1/device-0001/deploymentBase/9120?c=1234567890' } } } } } },

        { id: 'ddi-config', m: 'PUT', p: '/{tenant}/controller/v1/{controllerId}/configData',
          t: 'Report what I am', auth: 'device',
          d: 'The device\'s <b>attributes</b>. This is what channel rules, centres and systems are ' +
             'built on — <code>ring</code>, <code>centerid</code>, <code>device_type</code>, ' +
             '<code>device</code>. <code>mode</code> is <code>merge</code>, <code>replace</code> or ' +
             '<code>remove</code>.',
          body: { mode: 'merge', data: { ring: 'beta', centerid: 'c01', device_type: 'device2',
            device: 'device-07', os_version: '2.1.0' } },
          res: { 200: { d: 'Taken.' } } } ] },

      { t: 'Deployments', eps: [
        { id: 'ddi-deployment', m: 'GET', p: '/{tenant}/controller/v1/{controllerId}/deploymentBase/{actionId}',
          t: 'Fetch an update', auth: 'device',
          d: 'What to install, and how. <code>download</code> and <code>update</code> are ' +
             '<code>skip</code>, <code>attempt</code> or <code>forced</code>; ' +
             '<code>maintenanceWindow</code> is <code>available</code> or <code>unavailable</code> ' +
             '— a device outside its window downloads but does not install.',
          pp: [['actionId', 'integer', 1, 'From the poll\'s link.']],
          q: [['c', 'integer', 0, 'The cache-busting value from the link. Pass it back unchanged.']],
          res: { 200: { d: 'The deployment.', ex: { id: '9120',
            deployment: { download: 'forced', update: 'forced', maintenanceWindow: 'available',
              chunks: [ { part: 'os', name: 'app', version: '1.2.0', artifacts: [ {
                filename: 'app-1.2.0.swu', hashes: { sha1: '…', md5: '…', sha256: '…' },
                size: 41943040, _links: { download: { href: '…' }, 'download-http': { href: '…' } } } ] } ] } } } } },

        { id: 'ddi-feedback', m: 'POST', p: '/{tenant}/controller/v1/{controllerId}/deploymentBase/{actionId}/feedback',
          t: 'Say how it went', auth: 'device',
          d: '<code>execution</code> is <code>closed</code>, <code>proceeding</code>, ' +
             '<code>downloaded</code>, <code>scheduled</code>, <code>rejected</code> or ' +
             '<code>canceled</code>; <code>result.finished</code> is <code>success</code>, ' +
             '<code>failure</code> or <code>none</code>. <b>This is what everything else turns on</b> ' +
             ': gates, error thresholds, and whether a system carries on or goes back.',
          pp: [['actionId', 'integer', 1, 'The action.']],
          body: { id: '9120', status: { execution: 'closed', result: { finished: 'success' },
            details: ['installed app 1.2.0'] } },
          res: { 200: { d: 'Recorded.' } } },

        { id: 'ddi-cancel', m: 'GET', p: '/{tenant}/controller/v1/{controllerId}/cancelAction/{actionId}',
          t: 'Fetch a cancellation', auth: 'device',
          pp: [['actionId', 'integer', 1, 'The action to stop.']],
          res: { 200: { d: 'Which action to stop.' } } },
        { id: 'ddi-cancel-fb', m: 'POST', p: '/{tenant}/controller/v1/{controllerId}/cancelAction/{actionId}/feedback',
          t: 'Confirm a cancellation', auth: 'device',
          pp: [['actionId', 'integer', 1, 'The action.']],
          body: { id: '9120', status: { execution: 'closed', result: { finished: 'success' } } },
          res: { 200: { d: 'Recorded.' } } },

        { id: 'ddi-installed', m: 'PUT', p: '/{tenant}/controller/v1/{controllerId}/installedBase',
          t: 'Report what is installed', auth: 'device',
          res: { 200: { d: 'Recorded.' } } },
        { id: 'ddi-installed-get', m: 'GET', p: '/{tenant}/controller/v1/{controllerId}/installedBase/{actionId}',
          t: 'Read an installed action', auth: 'device',
          pp: [['actionId', 'integer', 1, 'The action.']],
          res: { 200: { d: 'What that action installed.' } } } ] },

      { t: 'Confirmation', eps: [
        { id: 'ddi-confirm', m: 'GET', p: '/{tenant}/controller/v1/{controllerId}/confirmationBase',
          t: 'Anything to confirm?', auth: 'device', res: { 200: { d: 'A link, or nothing.' } } },
        { id: 'ddi-confirm-a', m: 'GET', p: '/{tenant}/controller/v1/{controllerId}/confirmationBase/{actionId}',
          t: 'Fetch a confirmation', auth: 'device',
          pp: [['actionId', 'integer', 1, 'The action.']], res: { 200: { d: 'The confirmation.' } } },
        { id: 'ddi-confirm-fb', m: 'POST', p: '/{tenant}/controller/v1/{controllerId}/confirmationBase/{actionId}/feedback',
          t: 'Confirm or deny', auth: 'device',
          pp: [['actionId', 'integer', 1, 'The action.']],
          body: { confirmation: 'confirmed', code: 0, details: ['the operator pressed go'] },
          res: { 200: { d: 'Recorded.' } } },
        { id: 'ddi-autoconf-on', m: 'POST', p: '/{tenant}/controller/v1/{controllerId}/confirmationBase/activateAutoConfirm',
          t: 'Confirm everything from now on', auth: 'device',
          body: { initiator: 'the operator', remark: 'unattended lane' }, res: { 200: { d: 'On.' } } },
        { id: 'ddi-autoconf-off', m: 'POST', p: '/{tenant}/controller/v1/{controllerId}/confirmationBase/deactivateAutoConfirm',
          t: 'Stop confirming everything', auth: 'device', res: { 200: { d: 'Off.' } } } ] },

      { t: 'Artifacts', eps: [
        { id: 'ddi-arts', m: 'GET', p: '/{tenant}/controller/v1/{controllerId}/softwaremodules/{smId}/artifacts',
          t: 'List a module\'s artifacts', auth: 'device',
          pp: [['smId', 'integer', 1, 'The software module.']],
          res: { 200: { d: 'The artifacts, with their hashes and download links.' } } },
        { id: 'ddi-download', m: 'GET', p: '/{tenant}/controller/v1/{controllerId}/softwaremodules/{smId}/artifacts/{fileName}',
          t: 'Download an artifact', auth: 'device',
          d: 'Supports <code>Range</code>, so a device on a bad line resumes where it stopped. Qawk ' +
             'records how far each download has got — that is what the console\'s progress bars read.',
          pp: [['smId', 'integer', 1, 'The module.'], ['fileName', 'string', 1, 'The artifact\'s filename.']],
          res: { 200: { d: 'The bytes.' }, 206: { d: 'The range asked for.' } } },
        { id: 'ddi-download-head', m: 'HEAD', p: '/{tenant}/controller/v1/{controllerId}/softwaremodules/{smId}/artifacts/{fileName}',
          t: 'Size and hash of an artifact', auth: 'device',
          pp: [['smId', 'integer', 1, 'The module.'], ['fileName', 'string', 1, 'The filename.']],
          res: { 200: { d: 'Headers only.' } } } ] }
    ]
  },

  // -------------------------------------------------------------- hawkBit
  mgmt: {
    id: 'mgmt',
    title: 'Management API',
    base: 'https://qawk.example.com',
    prefix: '/rest/v1',
    auth: 'basic',
    blurb: 'hawkBit\'s own <b>Management API</b>, under <code>/rest/v1</code> — all 153 operations, ' +
      'with hawkBit\'s JSON, status codes, error codes, query language, paging and headers. ' +
      'Anything written against hawkBit 1.1.0 works against Qawk unchanged, which is the point: ' +
      'this is not a subset and not a dialect.',
    note: 'Because it <i>is</i> hawkBit\'s API, the reference for it is hawkBit\'s own — and Qawk ' +
      'serves the OpenAPI document where hawkBit serves it, at ' +
      '<code>/v3/api-docs/Management API</code>, listing <b>only</b> the operations it really ' +
      'implements. Point your generator at the server you are actually talking to. What follows is ' +
      'the shape of it, and the handful of deliberate differences.',
    groups: [
      { t: 'The shape of it', eps: [
        { id: 'mgmt-targets', m: 'GET', p: '/rest/v1/targets', t: 'List devices',
          d: 'Paged, sorted and filtered like every collection in this API. <code>q</code> is ' +
             'hawkBit\'s query language — <code>FIQL</code>: <code>name==shop-prod-*</code>, ' +
             '<code>attribute.ring==beta;updatestatus==error</code>.',
          perm: 'READ_TARGET',
          q: [['offset', 'integer', 0, 'Where the page starts.'],
              ['limit', 'integer', 0, 'How many. Default <code>50</code>.'],
              ['sort', 'string', 0, '<code>name:ASC</code>, <code>lastModifiedAt:DESC</code>.'],
              ['q', 'string', 0, 'A FIQL query. <code>==</code>, <code>!=</code>, <code>=lt=</code>, <code>=gt=</code>, <code>=in=</code>; <code>;</code> is and, <code>,</code> is or; <code>*</code> wildcards.']],
          res: { 200: { d: 'A page of devices.', ex: { total: 2140, size: 1, content: [ {
            controllerId: 'shop-prod-017', name: 'shop-prod-017', updateStatus: 'in_sync',
            installedAt: 1758500000000, lastControllerRequestAt: 1758531200000,
            createdAt: 1757000000000, createdBy: 'admin' } ] } } } },

        { id: 'mgmt-ds', m: 'GET', p: '/rest/v1/distributionsets', t: 'List distribution sets',
          d: 'A distribution set is what a device is given: a version of a name, holding software ' +
             'modules. <code>app:1.2.0</code>.',
          perm: 'READ_REPOSITORY',
          q: [['q', 'string', 0, '<code>name==app;version==1.*</code>.'], ['limit', 'integer', 0, 'How many.']],
          res: { 200: { d: 'A page of sets.' } } },

        { id: 'mgmt-assign', m: 'POST', p: '/rest/v1/distributionsets/{dsId}/assignedTargets',
          t: 'Assign a set to devices',
          d: 'The plain way to update something: give these devices this set. Channels, rollouts and ' +
             'the orchestrator all end up here.',
          perm: 'UPDATE_TARGET',
          pp: [['dsId', 'integer', 1, 'The distribution set.']],
          body: [ { id: 'shop-prod-017', type: 'forced' }, { id: 'shop-prod-018', type: 'soft' } ],
          res: { 200: { d: 'How many were assigned, and how many already had it.',
            ex: { assigned: 1, alreadyAssigned: 1, assignedActions: [{ id: 9121 }] } } } },

        { id: 'mgmt-sm', m: 'POST', p: '/rest/v1/softwaremodules/{smId}/artifacts',
          t: 'Upload an artifact',
          d: 'Multipart. Qawk checks the hashes you send against the bytes it received before it ' +
             'accepts the upload.',
          perm: 'CREATE_REPOSITORY',
          pp: [['smId', 'integer', 1, 'The software module.']],
          ctype: 'multipart/form-data',
          res: { 201: { d: 'The artifact, with its hashes and size.' } } },

        { id: 'mgmt-rollouts', m: 'POST', p: '/rest/v1/rollouts', t: 'Create a rollout',
          d: 'hawkBit\'s own staged rollout: groups, thresholds, start and stop. Qawk runs these too ' +
             '— they are a different tool from channels, and both are here.',
          perm: 'CREATE_ROLLOUT',
          body: { name: 'prod 1.2.0', distributionSetId: 7, targetFilterQuery: 'attribute.ring==prod',
            amountGroups: 4, successCondition: { condition: 'THRESHOLD', expression: '90' },
            errorAction: { action: 'PAUSE', expression: '' } },
          res: { 201: { d: 'The rollout, ready to start.' } } },

        { id: 'mgmt-openapi', m: 'GET', p: '/v3/api-docs/{group}', t: 'The OpenAPI document',
          d: 'Where hawkBit publishes it. <code>{group}</code> is <code>Management API</code> or ' +
             '<code>Direct Device Integration API</code>; ' +
             '<code>/v3/api-docs/swagger-config</code> lists them. The descriptions are hawkBit ' +
             '1.1.0\'s own, and only the operations this server really implements are listed — so a ' +
             'generated client cannot be built against something that is not there.',
          auth: 'none',
          pp: [['group', 'string', 1, '<code>Management API</code> or <code>Direct Device Integration API</code>.']],
          res: { 200: { d: 'An OpenAPI 3.0 document.' } } }
      ] }
    ]
  }
};
