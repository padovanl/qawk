-- Download progress (a Qawk addition): how much of each artifact of an action
-- the device has taken.
--
-- hawkBit only knows what a device says, and SWUpdate says nothing between
-- "Installing Update Chunk Artifacts." and "Installed Chunk." -- eleven
-- seconds of silence measured on a system update, minutes on a slow link.
-- Qawk serves the bytes itself, so it knows, byte by byte, how far a download
-- has got, and when the last byte left: from then until the device reports,
-- the device is installing.
CREATE TABLE action_downloads (
    action_id    BIGINT  NOT NULL REFERENCES actions (id)   ON DELETE CASCADE,
    artifact_id  BIGINT  NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
    size         BIGINT  NOT NULL,
    bytes        BIGINT  NOT NULL DEFAULT 0,     -- served so far, capped at size
    ranged       BOOLEAN NOT NULL DEFAULT FALSE, -- fetched in ranges (a delta)
    started_at   BIGINT  NOT NULL,
    updated_at   BIGINT  NOT NULL,
    completed_at BIGINT,
    PRIMARY KEY (action_id, artifact_id)
);
