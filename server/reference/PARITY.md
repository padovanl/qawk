# hawkBit 1.1.0 parity — every operation

Generated from hawkBit 1.1.0's OpenAPI descriptions (the files beside this
one). One line per operation, in the order of the server's own areas.

> **This file is a checklist kept by hand, and the boxes in it are not the
> authoritative answer.** What a given server really implements is what that
> server says: `GET /v3/api-docs/swagger-config` lists the groups, and
> `GET /v3/api-docs/<group>` returns hawkBit's own description filtered to the
> operations that are actually routed. Generate clients from that, not from
> this. What "the same as hawkBit" means, and the five deliberate differences,
> are in [../README.md](../README.md#hawkbit-parity).

## Direct Device Integration API (devices)

### DDI Root Controller

- [ ] `GET    /{tenant}/controller/v1/{controllerId}` — Root resource for an individual Target
- [ ] `GET    /{tenant}/controller/v1/{controllerId}/cancelAction/{actionId}` — Cancel an action
- [ ] `POST   /{tenant}/controller/v1/{controllerId}/cancelAction/{actionId}/feedback` — Feedback channel for cancel actions
- [ ] `PUT    /{tenant}/controller/v1/{controllerId}/configData` — Feedback channel for the config data action
- [ ] `GET    /{tenant}/controller/v1/{controllerId}/confirmationBase` — Resource to request confirmation specific information for the controller
- [ ] `POST   /{tenant}/controller/v1/{controllerId}/confirmationBase/activateAutoConfirm` — Interface to activate auto-confirmation for a specific device
- [ ] `POST   /{tenant}/controller/v1/{controllerId}/confirmationBase/deactivateAutoConfirm` — Interface to deactivate auto-confirmation for a specific controller
- [ ] `GET    /{tenant}/controller/v1/{controllerId}/confirmationBase/{actionId}` — Confirmation status of an action
- [ ] `POST   /{tenant}/controller/v1/{controllerId}/confirmationBase/{actionId}/feedback` — Feedback channel for actions waiting for confirmation
- [ ] `GET    /{tenant}/controller/v1/{controllerId}/deploymentBase/{actionId}` — Resource for software module (Deployment Base)
- [ ] `POST   /{tenant}/controller/v1/{controllerId}/deploymentBase/{actionId}/feedback` — Feedback channel for the DeploymentBase action
- [ ] `PUT    /{tenant}/controller/v1/{controllerId}/installedBase` — Set offline assigned version
- [ ] `GET    /{tenant}/controller/v1/{controllerId}/installedBase/{actionId}` — Previously installed action
- [ ] `GET    /{tenant}/controller/v1/{controllerId}/softwaremodules/{softwareModuleId}/artifacts` — Return all artifacts of a given software module and target
- [ ] `GET    /{tenant}/controller/v1/{controllerId}/softwaremodules/{softwareModuleId}/artifacts/{fileName}` — Artifact download
- [ ] `GET    /{tenant}/controller/v1/{controllerId}/softwaremodules/{softwareModuleId}/artifacts/{fileName}.MD5SUM` — MD5 checksum download

## Management API (the console, and scripts)

### Actions

- [ ] `DELETE /rest/v1/actions` — Delete multiple actions by list OR rsql filter
- [ ] `GET    /rest/v1/actions` — Return all actions
- [ ] `DELETE /rest/v1/actions/{actionId}` — Delete a single action by id
- [ ] `GET    /rest/v1/actions/{actionId}` — Return action by id

### Basic Authentication

- [ ] `GET    /rest/v1/userinfo` — 

### Distribution Set Tags

- [ ] `GET    /rest/v1/distributionsettags` — Return all Distribution Set Tags
- [ ] `POST   /rest/v1/distributionsettags` — Creates new Distribution Set Tags
- [ ] `DELETE /rest/v1/distributionsettags/{distributionsetTagId}` — Delete a single distribution set tag
- [ ] `GET    /rest/v1/distributionsettags/{distributionsetTagId}` — Return single Distribution Set Tag
- [ ] `PUT    /rest/v1/distributionsettags/{distributionsetTagId}` — Update Distribution Set Tag
- [ ] `DELETE /rest/v1/distributionsettags/{distributionsetTagId}/assigned` — Unassign multiple distribution sets from the given tag id
- [ ] `GET    /rest/v1/distributionsettags/{distributionsetTagId}/assigned` — Return all assigned distribution sets by given tag Id
- [ ] `POST   /rest/v1/distributionsettags/{distributionsetTagId}/assigned` — Assign distribution sets to the given tag id
- [ ] `DELETE /rest/v1/distributionsettags/{distributionsetTagId}/assigned/{distributionsetId}` — Unassign one distribution set from the given tag id
- [ ] `POST   /rest/v1/distributionsettags/{distributionsetTagId}/assigned/{distributionsetId}` — Assign distribution set to the given tag id

### Distribution Set Types

- [ ] `GET    /rest/v1/distributionsettypes` — Return all Distribution Set Types
- [ ] `POST   /rest/v1/distributionsettypes` — Create new distribution set types
- [ ] `DELETE /rest/v1/distributionsettypes/{distributionSetTypeId}` — Delete Distribution Set Type by Id
- [ ] `GET    /rest/v1/distributionsettypes/{distributionSetTypeId}` — Return single Distribution Set Type
- [ ] `PUT    /rest/v1/distributionsettypes/{distributionSetTypeId}` — Update Distribution Set Type
- [ ] `GET    /rest/v1/distributionsettypes/{distributionSetTypeId}/mandatorymoduletypes` — Return mandatory Software Module Types in a Distribution Set Type
- [ ] `POST   /rest/v1/distributionsettypes/{distributionSetTypeId}/mandatorymoduletypes` — Add mandatory Software Module Type to a Distribution Set Type
- [ ] `DELETE /rest/v1/distributionsettypes/{distributionSetTypeId}/mandatorymoduletypes/{softwareModuleTypeId}` — Delete a mandatory module from a Distribution Set Type
- [ ] `GET    /rest/v1/distributionsettypes/{distributionSetTypeId}/mandatorymoduletypes/{softwareModuleTypeId}` — Return single mandatory Software Module Type in a Distribution Set Type
- [ ] `GET    /rest/v1/distributionsettypes/{distributionSetTypeId}/optionalmoduletypes` — Return optional Software Module Types in a Distribution Set Type
- [ ] `POST   /rest/v1/distributionsettypes/{distributionSetTypeId}/optionalmoduletypes` — Add optional Software Module Type to a Distribution Set Type
- [ ] `DELETE /rest/v1/distributionsettypes/{distributionSetTypeId}/optionalmoduletypes/{softwareModuleTypeId}` — Delete an optional module from a Distribution Set Type
- [ ] `GET    /rest/v1/distributionsettypes/{distributionSetTypeId}/optionalmoduletypes/{softwareModuleTypeId}` — Return single optional Software Module Type in a Distribution Set Type

### Distribution Sets

- [ ] `GET    /rest/v1/distributionsets` — Return all Distribution Sets
- [ ] `POST   /rest/v1/distributionsets` — Creates new Distribution Sets
- [ ] `DELETE /rest/v1/distributionsets/{distributionSetId}` — Delete Distribution Set by Id
- [ ] `GET    /rest/v1/distributionsets/{distributionSetId}` — Return single Distribution Set
- [ ] `PUT    /rest/v1/distributionsets/{distributionSetId}` — Update Distribution Set
- [ ] `GET    /rest/v1/distributionsets/{distributionSetId}/assignedSM` — Return the assigned software modules of a specific distribution set
- [ ] `POST   /rest/v1/distributionsets/{distributionSetId}/assignedSM` — Assign a list of software modules to a distribution set
- [ ] `DELETE /rest/v1/distributionsets/{distributionSetId}/assignedSM/{softwareModuleId}` — Delete the assignment of the software module from the distribution set
- [ ] `GET    /rest/v1/distributionsets/{distributionSetId}/assignedTargets` — Return assigned targets to a specific distribution set
- [ ] `POST   /rest/v1/distributionsets/{distributionSetId}/assignedTargets` — Assigning multiple targets to a single distribution set
- [ ] `GET    /rest/v1/distributionsets/{distributionSetId}/autoAssignTargetFilters` — Return target filter queries that have the given distribution set as auto assign DS
- [ ] `GET    /rest/v1/distributionsets/{distributionSetId}/installedTargets` — Return installed targets to a specific distribution set
- [ ] `POST   /rest/v1/distributionsets/{distributionSetId}/invalidate` — Invalidate a distribution set
- [ ] `GET    /rest/v1/distributionsets/{distributionSetId}/metadata` — Return meta data for Distribution Set
- [ ] `POST   /rest/v1/distributionsets/{distributionSetId}/metadata` — Create a list of meta data for a specific distribution set
- [ ] `DELETE /rest/v1/distributionsets/{distributionSetId}/metadata/{metadataKey}` — Delete a single meta data entry from the distribution set
- [ ] `GET    /rest/v1/distributionsets/{distributionSetId}/metadata/{metadataKey}` — Return single meta data value for a specific key of a Distribution Set
- [ ] `PUT    /rest/v1/distributionsets/{distributionSetId}/metadata/{metadataKey}` — Update single meta data value of a distribution set
- [ ] `GET    /rest/v1/distributionsets/{distributionSetId}/statistics` — Return Rollouts, Actions and Auto Assignments counts by Status for Distribution Set
- [ ] `GET    /rest/v1/distributionsets/{distributionSetId}/statistics/actions` — Return Actions count by status for Distribution Set
- [ ] `GET    /rest/v1/distributionsets/{distributionSetId}/statistics/autoassignments` — Return Auto Assignments count for Distribution Set
- [ ] `GET    /rest/v1/distributionsets/{distributionSetId}/statistics/rollouts` — Return Rollouts count by status for Distribution Set

### Download artifact

- [ ] `GET    /rest/v1/softwaremodules/{softwareModuleId}/artifacts/{artifactId}/download` — 

### Rollouts

- [ ] `GET    /rest/v1/rollouts` — Return all Rollouts
- [ ] `POST   /rest/v1/rollouts` — Create a new Rollout
- [ ] `DELETE /rest/v1/rollouts/{rolloutId}` — Delete a Rollout
- [ ] `GET    /rest/v1/rollouts/{rolloutId}` — Return single Rollout
- [ ] `PUT    /rest/v1/rollouts/{rolloutId}` — Update Rollout
- [ ] `POST   /rest/v1/rollouts/{rolloutId}/approve` — Approve a Rollout
- [ ] `POST   /rest/v1/rollouts/{rolloutId}/deny` — Deny a Rollout
- [ ] `GET    /rest/v1/rollouts/{rolloutId}/deploygroups` — Return all rollout groups referred to a Rollout
- [ ] `GET    /rest/v1/rollouts/{rolloutId}/deploygroups/{groupId}` — Return single rollout group
- [ ] `GET    /rest/v1/rollouts/{rolloutId}/deploygroups/{groupId}/targets` — Return all targets related to a specific rollout group
- [ ] `POST   /rest/v1/rollouts/{rolloutId}/pause` — Pause a Rollout
- [ ] `POST   /rest/v1/rollouts/{rolloutId}/resume` — Resume a Rollout
- [ ] `POST   /rest/v1/rollouts/{rolloutId}/retry` — Retry a rollout
- [ ] `POST   /rest/v1/rollouts/{rolloutId}/start` — Start a Rollout
- [ ] `POST   /rest/v1/rollouts/{rolloutId}/stop` — Stop a Rollout
- [ ] `POST   /rest/v1/rollouts/{rolloutId}/triggerNextGroup` — Force trigger processing next group of a Rollout

### Software Module Types

- [ ] `GET    /rest/v1/softwaremoduletypes` — Return all Software Module Types
- [ ] `POST   /rest/v1/softwaremoduletypes` — Creates new Software Module Types
- [ ] `DELETE /rest/v1/softwaremoduletypes/{softwareModuleTypeId}` — Delete Software Module Type by Id
- [ ] `GET    /rest/v1/softwaremoduletypes/{softwareModuleTypeId}` — Return single Software Module Type
- [ ] `PUT    /rest/v1/softwaremoduletypes/{softwareModuleTypeId}` — Update Software Module Type

### Software Modules

- [ ] `GET    /rest/v1/softwaremodules` — Return all Software modules
- [ ] `POST   /rest/v1/softwaremodules` — Create Software Module(s)
- [ ] `DELETE /rest/v1/softwaremodules/{softwareModuleId}` — Delete Software Module by Id
- [ ] `GET    /rest/v1/softwaremodules/{softwareModuleId}` — Return Software Module by id
- [ ] `PUT    /rest/v1/softwaremodules/{softwareModuleId}` — Update Software Module
- [ ] `GET    /rest/v1/softwaremodules/{softwareModuleId}/artifacts` — Return all metadata of artifacts assigned to a software module
- [ ] `POST   /rest/v1/softwaremodules/{softwareModuleId}/artifacts` — Upload artifact
- [ ] `DELETE /rest/v1/softwaremodules/{softwareModuleId}/artifacts/{artifactId}` — Delete artifact by Id
- [ ] `GET    /rest/v1/softwaremodules/{softwareModuleId}/artifacts/{artifactId}` — Return single Artifact metadata
- [ ] `GET    /rest/v1/softwaremodules/{softwareModuleId}/metadata` — Return metadata for a Software Module
- [ ] `POST   /rest/v1/softwaremodules/{softwareModuleId}/metadata` — Creates a list of metadata for a specific Software Module
- [ ] `DELETE /rest/v1/softwaremodules/{softwareModuleId}/metadata/{metadataKey}` — Delete single metadata entry from the software module
- [ ] `GET    /rest/v1/softwaremodules/{softwareModuleId}/metadata/{metadataKey}` — Return single metadata value for a specific key of a Software Module
- [ ] `PUT    /rest/v1/softwaremodules/{softwareModuleId}/metadata/{metadataKey}` — Update a single metadata value of a Software Module

### System Configuration

- [ ] `GET    /rest/v1/system/configs` — Return all tenant specific configuration values
- [ ] `PUT    /rest/v1/system/configs` — Batch update of tenant configuration.
- [ ] `DELETE /rest/v1/system/configs/{keyName}` — Delete a tenant specific configuration value
- [ ] `GET    /rest/v1/system/configs/{keyName}` — Return a tenant specific configuration value
- [ ] `PUT    /rest/v1/system/configs/{keyName}` — Update a tenant specific configuration value.

### Target Filter Queries

- [ ] `GET    /rest/v1/targetfilters` — Return all target filter queries
- [ ] `POST   /rest/v1/targetfilters` — Create target filter
- [ ] `DELETE /rest/v1/targetfilters/{filterId}` — Delete target filter by id
- [ ] `GET    /rest/v1/targetfilters/{filterId}` — Return target filter query by id
- [ ] `PUT    /rest/v1/targetfilters/{filterId}` — Updates target filter query by id
- [ ] `DELETE /rest/v1/targetfilters/{filterId}/autoAssignDS` — Remove Distribution Set for auto assignment of a target filter
- [ ] `GET    /rest/v1/targetfilters/{filterId}/autoAssignDS` — Return distribution set for auto assignment of a specific target filter
- [ ] `POST   /rest/v1/targetfilters/{filterId}/autoAssignDS` — Set auto assignment of distribution set for a target filter query

### Target Groups

- [ ] `DELETE /rest/v1/targetgroups` — Unassign targets from their target groups by filter
- [ ] `GET    /rest/v1/targetgroups` — Return all assigned target groups
- [ ] `PUT    /rest/v1/targetgroups` — Assign targets matching a rsql filter to provided target group
- [ ] `DELETE /rest/v1/targetgroups/assigned` — Unassign targets from their target groups
- [ ] `GET    /rest/v1/targetgroups/assigned` — Return assigned targets for group
- [ ] `PUT    /rest/v1/targetgroups/assigned` — Assign target(s) to given group
- [ ] `PUT    /rest/v1/targetgroups/{group}` — Assign target(s) to given group by rsql
- [ ] `GET    /rest/v1/targetgroups/{group}/assigned` — Return assigned targets for group
- [ ] `PUT    /rest/v1/targetgroups/{group}/assigned` — Assign target(s) to given group

### Target Tags

- [ ] `GET    /rest/v1/targettags` — Return all target tags
- [ ] `POST   /rest/v1/targettags` — Create target tag(s)
- [ ] `DELETE /rest/v1/targettags/{targetTagId}` — Delete target tag by id
- [ ] `GET    /rest/v1/targettags/{targetTagId}` — Return target tag by id
- [ ] `PUT    /rest/v1/targettags/{targetTagId}` — Update target tag by id
- [ ] `DELETE /rest/v1/targettags/{targetTagId}/assigned` — Unassign targets from a given tagId
- [ ] `GET    /rest/v1/targettags/{targetTagId}/assigned` — Return assigned targets for tag
- [ ] `POST   /rest/v1/targettags/{targetTagId}/assigned` — Assign target(s) to given tagId
- [ ] `DELETE /rest/v1/targettags/{targetTagId}/assigned/{controllerId}` — Unassign target from a given tagId
- [ ] `POST   /rest/v1/targettags/{targetTagId}/assigned/{controllerId}` — Assign target(s) to given tagId

### Target Types

- [ ] `GET    /rest/v1/targettypes` — Return all target types
- [ ] `POST   /rest/v1/targettypes` — Create target types
- [ ] `DELETE /rest/v1/targettypes/{targetTypeId}` — Delete target type by id
- [ ] `GET    /rest/v1/targettypes/{targetTypeId}` — Return target type by id
- [ ] `PUT    /rest/v1/targettypes/{targetTypeId}` — Update target type by id
- [ ] `GET    /rest/v1/targettypes/{targetTypeId}/compatibledistributionsettypes` — Return list of compatible distribution set types
- [ ] `POST   /rest/v1/targettypes/{targetTypeId}/compatibledistributionsettypes` — Adding compatibility of a distribution set type to a target type
- [ ] `DELETE /rest/v1/targettypes/{targetTypeId}/compatibledistributionsettypes/{distributionSetTypeId}` — Remove compatibility of distribution set type from the target type

### Targets

- [ ] `GET    /rest/v1/targets` — Return all targets
- [ ] `POST   /rest/v1/targets` — Create target(s)
- [ ] `DELETE /rest/v1/targets/{targetId}` — Delete target by id
- [ ] `GET    /rest/v1/targets/{targetId}` — Return target by id
- [ ] `PUT    /rest/v1/targets/{targetId}` — Update target by id
- [ ] `DELETE /rest/v1/targets/{targetId}/actions` — Deletes all actions for the provided target EXCEPT the latest N actions OR by provided action IDs list.
- [ ] `GET    /rest/v1/targets/{targetId}/actions` — Return actions for a specific target
- [ ] `DELETE /rest/v1/targets/{targetId}/actions/{actionId}` — Cancel action for a specific target
- [ ] `GET    /rest/v1/targets/{targetId}/actions/{actionId}` — Return action by id of a specific target
- [ ] `PUT    /rest/v1/targets/{targetId}/actions/{actionId}` — Switch an action from soft to forced
- [ ] `PUT    /rest/v1/targets/{targetId}/actions/{actionId}/confirmation` — Controls (confirm/deny) actions waiting for confirmation
- [ ] `GET    /rest/v1/targets/{targetId}/actions/{actionId}/status` — Return status of a specific action on a specific target
- [ ] `GET    /rest/v1/targets/{targetId}/assignedDS` — Return the assigned distribution set of a specific target
- [ ] `POST   /rest/v1/targets/{targetId}/assignedDS` — Assigns a distribution set to a specific target
- [ ] `GET    /rest/v1/targets/{targetId}/attributes` — Return attributes of a specific target
- [ ] `GET    /rest/v1/targets/{targetId}/autoConfirm` — Return the current auto-confitm state for a specific target
- [ ] `POST   /rest/v1/targets/{targetId}/autoConfirm/activate` — Activate auto-confirm on a specific target
- [ ] `POST   /rest/v1/targets/{targetId}/autoConfirm/deactivate` — Deactivate auto-confirm on a specific target
- [ ] `GET    /rest/v1/targets/{targetId}/installedDS` — Return installed distribution set of a specific target
- [ ] `GET    /rest/v1/targets/{targetId}/metadata` — Return metadata for specific target
- [ ] `POST   /rest/v1/targets/{targetId}/metadata` — Create a list of metadata for a specific target
- [ ] `DELETE /rest/v1/targets/{targetId}/metadata/{metadataKey}` — Deletes a single metadata entry from a target
- [ ] `GET    /rest/v1/targets/{targetId}/metadata/{metadataKey}` — Return single metadata value for a specific key of a target
- [ ] `PUT    /rest/v1/targets/{targetId}/metadata/{metadataKey}` — Updates a single metadata value of a target
- [ ] `GET    /rest/v1/targets/{targetId}/tags` — Return tags for specific target
- [ ] `DELETE /rest/v1/targets/{targetId}/targettype` — Unassign target type from target.
- [ ] `POST   /rest/v1/targets/{targetId}/targettype` — Assign target type to a target

