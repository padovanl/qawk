# hawkBit 1.1.0 parity — every operation

**Generated, not kept by hand.** Every line below was produced by comparing
hawkBit 1.1.0's own OpenAPI descriptions (the files beside this one) with what a
running Qawk declares at `/v3/api-docs`, which is built by walking its router.
`[x]` means the server really routes that operation.

Regenerate it with `python3 server/test/parity.py <server>`. The contract test
(`server/test/contract.py`) checks both totals on every run, so a route that
disappears fails the build rather than quietly rotting this file.

What "the same as hawkBit" means, and the five deliberate differences, are in
[../README.md](../README.md#hawkbit-parity) and on the
[documentation site](https://padovanl.github.io/qawk/hawkbit/).


## Direct Device Integration API (devices)

**16 of 16 operations.**


### DDI Root Controller

- [x] `GET    /{tenant}/controller/v1/{controllerId}` — Root resource for an individual Target
- [x] `GET    /{tenant}/controller/v1/{controllerId}/cancelAction/{actionId}` — Cancel an action
- [x] `POST   /{tenant}/controller/v1/{controllerId}/cancelAction/{actionId}/feedback` — Feedback channel for cancel actions
- [x] `PUT    /{tenant}/controller/v1/{controllerId}/configData` — Feedback channel for the config data action
- [x] `GET    /{tenant}/controller/v1/{controllerId}/confirmationBase` — Resource to request confirmation specific information for the controller
- [x] `POST   /{tenant}/controller/v1/{controllerId}/confirmationBase/activateAutoConfirm` — Interface to activate auto-confirmation for a specific device
- [x] `POST   /{tenant}/controller/v1/{controllerId}/confirmationBase/deactivateAutoConfirm` — Interface to deactivate auto-confirmation for a specific controller
- [x] `GET    /{tenant}/controller/v1/{controllerId}/confirmationBase/{actionId}` — Confirmation status of an action
- [x] `POST   /{tenant}/controller/v1/{controllerId}/confirmationBase/{actionId}/feedback` — Feedback channel for actions waiting for confirmation
- [x] `GET    /{tenant}/controller/v1/{controllerId}/deploymentBase/{actionId}` — Resource for software module (Deployment Base)
- [x] `POST   /{tenant}/controller/v1/{controllerId}/deploymentBase/{actionId}/feedback` — Feedback channel for the DeploymentBase action
- [x] `PUT    /{tenant}/controller/v1/{controllerId}/installedBase` — Set offline assigned version
- [x] `GET    /{tenant}/controller/v1/{controllerId}/installedBase/{actionId}` — Previously installed action
- [x] `GET    /{tenant}/controller/v1/{controllerId}/softwaremodules/{softwareModuleId}/artifacts` — Return all artifacts of a given software module and target
- [x] `GET    /{tenant}/controller/v1/{controllerId}/softwaremodules/{softwareModuleId}/artifacts/{fileName}` — Artifact download
- [x] `GET    /{tenant}/controller/v1/{controllerId}/softwaremodules/{softwareModuleId}/artifacts/{fileName}.MD5SUM` — MD5 checksum download


## Management API (the console, and scripts)

**153 of 153 operations.**


### Actions

- [x] `DELETE /rest/v1/actions` — Delete multiple actions by list OR rsql filter
- [x] `GET    /rest/v1/actions` — Return all actions
- [x] `DELETE /rest/v1/actions/{actionId}` — Delete a single action by id
- [x] `GET    /rest/v1/actions/{actionId}` — Return action by id

### Basic Authentication

- [x] `GET    /rest/v1/userinfo`

### Distribution Set Tags

- [x] `GET    /rest/v1/distributionsettags` — Return all Distribution Set Tags
- [x] `POST   /rest/v1/distributionsettags` — Creates new Distribution Set Tags
- [x] `DELETE /rest/v1/distributionsettags/{distributionsetTagId}` — Delete a single distribution set tag
- [x] `GET    /rest/v1/distributionsettags/{distributionsetTagId}` — Return single Distribution Set Tag
- [x] `PUT    /rest/v1/distributionsettags/{distributionsetTagId}` — Update Distribution Set Tag
- [x] `DELETE /rest/v1/distributionsettags/{distributionsetTagId}/assigned` — Unassign multiple distribution sets from the given tag id
- [x] `GET    /rest/v1/distributionsettags/{distributionsetTagId}/assigned` — Return all assigned distribution sets by given tag Id
- [x] `POST   /rest/v1/distributionsettags/{distributionsetTagId}/assigned` — Assign distribution sets to the given tag id
- [x] `DELETE /rest/v1/distributionsettags/{distributionsetTagId}/assigned/{distributionsetId}` — Unassign one distribution set from the given tag id
- [x] `POST   /rest/v1/distributionsettags/{distributionsetTagId}/assigned/{distributionsetId}` — Assign distribution set to the given tag id

### Distribution Set Types

- [x] `GET    /rest/v1/distributionsettypes` — Return all Distribution Set Types
- [x] `POST   /rest/v1/distributionsettypes` — Create new distribution set types
- [x] `DELETE /rest/v1/distributionsettypes/{distributionSetTypeId}` — Delete Distribution Set Type by Id
- [x] `GET    /rest/v1/distributionsettypes/{distributionSetTypeId}` — Return single Distribution Set Type
- [x] `PUT    /rest/v1/distributionsettypes/{distributionSetTypeId}` — Update Distribution Set Type
- [x] `GET    /rest/v1/distributionsettypes/{distributionSetTypeId}/mandatorymoduletypes` — Return mandatory Software Module Types in a Distribution Set Type
- [x] `POST   /rest/v1/distributionsettypes/{distributionSetTypeId}/mandatorymoduletypes` — Add mandatory Software Module Type to a Distribution Set Type
- [x] `DELETE /rest/v1/distributionsettypes/{distributionSetTypeId}/mandatorymoduletypes/{softwareModuleTypeId}` — Delete a mandatory module from a Distribution Set Type
- [x] `GET    /rest/v1/distributionsettypes/{distributionSetTypeId}/mandatorymoduletypes/{softwareModuleTypeId}` — Return single mandatory Software Module Type in a Distribution Set Type
- [x] `GET    /rest/v1/distributionsettypes/{distributionSetTypeId}/optionalmoduletypes` — Return optional Software Module Types in a Distribution Set Type
- [x] `POST   /rest/v1/distributionsettypes/{distributionSetTypeId}/optionalmoduletypes` — Add optional Software Module Type to a Distribution Set Type
- [x] `DELETE /rest/v1/distributionsettypes/{distributionSetTypeId}/optionalmoduletypes/{softwareModuleTypeId}` — Delete an optional module from a Distribution Set Type
- [x] `GET    /rest/v1/distributionsettypes/{distributionSetTypeId}/optionalmoduletypes/{softwareModuleTypeId}` — Return single optional Software Module Type in a Distribution Set Type

### Distribution Sets

- [x] `GET    /rest/v1/distributionsets` — Return all Distribution Sets
- [x] `POST   /rest/v1/distributionsets` — Creates new Distribution Sets
- [x] `DELETE /rest/v1/distributionsets/{distributionSetId}` — Delete Distribution Set by Id
- [x] `GET    /rest/v1/distributionsets/{distributionSetId}` — Return single Distribution Set
- [x] `PUT    /rest/v1/distributionsets/{distributionSetId}` — Update Distribution Set
- [x] `GET    /rest/v1/distributionsets/{distributionSetId}/assignedSM` — Return the assigned software modules of a specific distribution set
- [x] `POST   /rest/v1/distributionsets/{distributionSetId}/assignedSM` — Assign a list of software modules to a distribution set
- [x] `DELETE /rest/v1/distributionsets/{distributionSetId}/assignedSM/{softwareModuleId}` — Delete the assignment of the software module from the distribution set
- [x] `GET    /rest/v1/distributionsets/{distributionSetId}/assignedTargets` — Return assigned targets to a specific distribution set
- [x] `POST   /rest/v1/distributionsets/{distributionSetId}/assignedTargets` — Assigning multiple targets to a single distribution set
- [x] `GET    /rest/v1/distributionsets/{distributionSetId}/autoAssignTargetFilters` — Return target filter queries that have the given distribution set as auto assign DS
- [x] `GET    /rest/v1/distributionsets/{distributionSetId}/installedTargets` — Return installed targets to a specific distribution set
- [x] `POST   /rest/v1/distributionsets/{distributionSetId}/invalidate` — Invalidate a distribution set
- [x] `GET    /rest/v1/distributionsets/{distributionSetId}/metadata` — Return meta data for Distribution Set
- [x] `POST   /rest/v1/distributionsets/{distributionSetId}/metadata` — Create a list of meta data for a specific distribution set
- [x] `DELETE /rest/v1/distributionsets/{distributionSetId}/metadata/{metadataKey}` — Delete a single meta data entry from the distribution set
- [x] `GET    /rest/v1/distributionsets/{distributionSetId}/metadata/{metadataKey}` — Return single meta data value for a specific key of a Distribution Set
- [x] `PUT    /rest/v1/distributionsets/{distributionSetId}/metadata/{metadataKey}` — Update single meta data value of a distribution set
- [x] `GET    /rest/v1/distributionsets/{distributionSetId}/statistics` — Return Rollouts, Actions and Auto Assignments counts by Status for Distribution Set
- [x] `GET    /rest/v1/distributionsets/{distributionSetId}/statistics/actions` — Return Actions count by status for Distribution Set
- [x] `GET    /rest/v1/distributionsets/{distributionSetId}/statistics/autoassignments` — Return Auto Assignments count for Distribution Set
- [x] `GET    /rest/v1/distributionsets/{distributionSetId}/statistics/rollouts` — Return Rollouts count by status for Distribution Set

### Download artifact

- [x] `GET    /rest/v1/softwaremodules/{softwareModuleId}/artifacts/{artifactId}/download`

### Rollouts

- [x] `GET    /rest/v1/rollouts` — Return all Rollouts
- [x] `POST   /rest/v1/rollouts` — Create a new Rollout
- [x] `DELETE /rest/v1/rollouts/{rolloutId}` — Delete a Rollout
- [x] `GET    /rest/v1/rollouts/{rolloutId}` — Return single Rollout
- [x] `PUT    /rest/v1/rollouts/{rolloutId}` — Update Rollout
- [x] `POST   /rest/v1/rollouts/{rolloutId}/approve` — Approve a Rollout
- [x] `POST   /rest/v1/rollouts/{rolloutId}/deny` — Deny a Rollout
- [x] `GET    /rest/v1/rollouts/{rolloutId}/deploygroups` — Return all rollout groups referred to a Rollout
- [x] `GET    /rest/v1/rollouts/{rolloutId}/deploygroups/{groupId}` — Return single rollout group
- [x] `GET    /rest/v1/rollouts/{rolloutId}/deploygroups/{groupId}/targets` — Return all targets related to a specific rollout group
- [x] `POST   /rest/v1/rollouts/{rolloutId}/pause` — Pause a Rollout
- [x] `POST   /rest/v1/rollouts/{rolloutId}/resume` — Resume a Rollout
- [x] `POST   /rest/v1/rollouts/{rolloutId}/retry` — Retry a rollout
- [x] `POST   /rest/v1/rollouts/{rolloutId}/start` — Start a Rollout
- [x] `POST   /rest/v1/rollouts/{rolloutId}/stop` — Stop a Rollout
- [x] `POST   /rest/v1/rollouts/{rolloutId}/triggerNextGroup` — Force trigger processing next group of a Rollout

### Software Module Types

- [x] `GET    /rest/v1/softwaremoduletypes` — Return all Software Module Types
- [x] `POST   /rest/v1/softwaremoduletypes` — Creates new Software Module Types
- [x] `DELETE /rest/v1/softwaremoduletypes/{softwareModuleTypeId}` — Delete Software Module Type by Id
- [x] `GET    /rest/v1/softwaremoduletypes/{softwareModuleTypeId}` — Return single Software Module Type
- [x] `PUT    /rest/v1/softwaremoduletypes/{softwareModuleTypeId}` — Update Software Module Type

### Software Modules

- [x] `GET    /rest/v1/softwaremodules` — Return all Software modules
- [x] `POST   /rest/v1/softwaremodules` — Create Software Module(s)
- [x] `DELETE /rest/v1/softwaremodules/{softwareModuleId}` — Delete Software Module by Id
- [x] `GET    /rest/v1/softwaremodules/{softwareModuleId}` — Return Software Module by id
- [x] `PUT    /rest/v1/softwaremodules/{softwareModuleId}` — Update Software Module
- [x] `GET    /rest/v1/softwaremodules/{softwareModuleId}/artifacts` — Return all metadata of artifacts assigned to a software module
- [x] `POST   /rest/v1/softwaremodules/{softwareModuleId}/artifacts` — Upload artifact
- [x] `DELETE /rest/v1/softwaremodules/{softwareModuleId}/artifacts/{artifactId}` — Delete artifact by Id
- [x] `GET    /rest/v1/softwaremodules/{softwareModuleId}/artifacts/{artifactId}` — Return single Artifact metadata
- [x] `GET    /rest/v1/softwaremodules/{softwareModuleId}/metadata` — Return metadata for a Software Module
- [x] `POST   /rest/v1/softwaremodules/{softwareModuleId}/metadata` — Creates a list of metadata for a specific Software Module
- [x] `DELETE /rest/v1/softwaremodules/{softwareModuleId}/metadata/{metadataKey}` — Delete single metadata entry from the software module
- [x] `GET    /rest/v1/softwaremodules/{softwareModuleId}/metadata/{metadataKey}` — Return single metadata value for a specific key of a Software Module
- [x] `PUT    /rest/v1/softwaremodules/{softwareModuleId}/metadata/{metadataKey}` — Update a single metadata value of a Software Module

### System Configuration

- [x] `GET    /rest/v1/system/configs` — Return all tenant specific configuration values
- [x] `PUT    /rest/v1/system/configs` — Batch update of tenant configuration.
- [x] `DELETE /rest/v1/system/configs/{keyName}` — Delete a tenant specific configuration value
- [x] `GET    /rest/v1/system/configs/{keyName}` — Return a tenant specific configuration value
- [x] `PUT    /rest/v1/system/configs/{keyName}` — Update a tenant specific configuration value.

### Target Filter Queries

- [x] `GET    /rest/v1/targetfilters` — Return all target filter queries
- [x] `POST   /rest/v1/targetfilters` — Create target filter
- [x] `DELETE /rest/v1/targetfilters/{filterId}` — Delete target filter by id
- [x] `GET    /rest/v1/targetfilters/{filterId}` — Return target filter query by id
- [x] `PUT    /rest/v1/targetfilters/{filterId}` — Updates target filter query by id
- [x] `DELETE /rest/v1/targetfilters/{filterId}/autoAssignDS` — Remove Distribution Set for auto assignment of a target filter
- [x] `GET    /rest/v1/targetfilters/{filterId}/autoAssignDS` — Return distribution set for auto assignment of a specific target filter
- [x] `POST   /rest/v1/targetfilters/{filterId}/autoAssignDS` — Set auto assignment of distribution set for a target filter query

### Target Groups

- [x] `DELETE /rest/v1/targetgroups` — Unassign targets from their target groups by filter
- [x] `GET    /rest/v1/targetgroups` — Return all assigned target groups
- [x] `PUT    /rest/v1/targetgroups` — Assign targets matching a rsql filter to provided target group
- [x] `DELETE /rest/v1/targetgroups/assigned` — Unassign targets from their target groups
- [x] `GET    /rest/v1/targetgroups/assigned` — Return assigned targets for group
- [x] `PUT    /rest/v1/targetgroups/assigned` — Assign target(s) to given group
- [x] `PUT    /rest/v1/targetgroups/{group}` — Assign target(s) to given group by rsql
- [x] `GET    /rest/v1/targetgroups/{group}/assigned` — Return assigned targets for group
- [x] `PUT    /rest/v1/targetgroups/{group}/assigned` — Assign target(s) to given group

### Target Tags

- [x] `GET    /rest/v1/targettags` — Return all target tags
- [x] `POST   /rest/v1/targettags` — Create target tag(s)
- [x] `DELETE /rest/v1/targettags/{targetTagId}` — Delete target tag by id
- [x] `GET    /rest/v1/targettags/{targetTagId}` — Return target tag by id
- [x] `PUT    /rest/v1/targettags/{targetTagId}` — Update target tag by id
- [x] `DELETE /rest/v1/targettags/{targetTagId}/assigned` — Unassign targets from a given tagId
- [x] `GET    /rest/v1/targettags/{targetTagId}/assigned` — Return assigned targets for tag
- [x] `POST   /rest/v1/targettags/{targetTagId}/assigned` — Assign target(s) to given tagId
- [x] `DELETE /rest/v1/targettags/{targetTagId}/assigned/{controllerId}` — Unassign target from a given tagId
- [x] `POST   /rest/v1/targettags/{targetTagId}/assigned/{controllerId}` — Assign target(s) to given tagId

### Target Types

- [x] `GET    /rest/v1/targettypes` — Return all target types
- [x] `POST   /rest/v1/targettypes` — Create target types
- [x] `DELETE /rest/v1/targettypes/{targetTypeId}` — Delete target type by id
- [x] `GET    /rest/v1/targettypes/{targetTypeId}` — Return target type by id
- [x] `PUT    /rest/v1/targettypes/{targetTypeId}` — Update target type by id
- [x] `GET    /rest/v1/targettypes/{targetTypeId}/compatibledistributionsettypes` — Return list of compatible distribution set types
- [x] `POST   /rest/v1/targettypes/{targetTypeId}/compatibledistributionsettypes` — Adding compatibility of a distribution set type to a target type
- [x] `DELETE /rest/v1/targettypes/{targetTypeId}/compatibledistributionsettypes/{distributionSetTypeId}` — Remove compatibility of distribution set type from the target type

### Targets

- [x] `GET    /rest/v1/targets` — Return all targets
- [x] `POST   /rest/v1/targets` — Create target(s)
- [x] `DELETE /rest/v1/targets/{targetId}` — Delete target by id
- [x] `GET    /rest/v1/targets/{targetId}` — Return target by id
- [x] `PUT    /rest/v1/targets/{targetId}` — Update target by id
- [x] `DELETE /rest/v1/targets/{targetId}/actions` — Deletes all actions for the provided target EXCEPT the latest N actions OR by provided action IDs list.
- [x] `GET    /rest/v1/targets/{targetId}/actions` — Return actions for a specific target
- [x] `DELETE /rest/v1/targets/{targetId}/actions/{actionId}` — Cancel action for a specific target
- [x] `GET    /rest/v1/targets/{targetId}/actions/{actionId}` — Return action by id of a specific target
- [x] `PUT    /rest/v1/targets/{targetId}/actions/{actionId}` — Switch an action from soft to forced
- [x] `PUT    /rest/v1/targets/{targetId}/actions/{actionId}/confirmation` — Controls (confirm/deny) actions waiting for confirmation
- [x] `GET    /rest/v1/targets/{targetId}/actions/{actionId}/status` — Return status of a specific action on a specific target
- [x] `GET    /rest/v1/targets/{targetId}/assignedDS` — Return the assigned distribution set of a specific target
- [x] `POST   /rest/v1/targets/{targetId}/assignedDS` — Assigns a distribution set to a specific target
- [x] `GET    /rest/v1/targets/{targetId}/attributes` — Return attributes of a specific target
- [x] `GET    /rest/v1/targets/{targetId}/autoConfirm` — Return the current auto-confitm state for a specific target
- [x] `POST   /rest/v1/targets/{targetId}/autoConfirm/activate` — Activate auto-confirm on a specific target
- [x] `POST   /rest/v1/targets/{targetId}/autoConfirm/deactivate` — Deactivate auto-confirm on a specific target
- [x] `GET    /rest/v1/targets/{targetId}/installedDS` — Return installed distribution set of a specific target
- [x] `GET    /rest/v1/targets/{targetId}/metadata` — Return metadata for specific target
- [x] `POST   /rest/v1/targets/{targetId}/metadata` — Create a list of metadata for a specific target
- [x] `DELETE /rest/v1/targets/{targetId}/metadata/{metadataKey}` — Deletes a single metadata entry from a target
- [x] `GET    /rest/v1/targets/{targetId}/metadata/{metadataKey}` — Return single metadata value for a specific key of a target
- [x] `PUT    /rest/v1/targets/{targetId}/metadata/{metadataKey}` — Updates a single metadata value of a target
- [x] `GET    /rest/v1/targets/{targetId}/tags` — Return tags for specific target
- [x] `DELETE /rest/v1/targets/{targetId}/targettype` — Unassign target type from target.
- [x] `POST   /rest/v1/targets/{targetId}/targettype` — Assign target type to a target

