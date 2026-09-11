-- Automatic promotion (a Qawk addition).
--
-- By default a fleet is promoted by hand: someone looks at the gate -- so many
-- devices of the upstream on the release, for so long -- decides, and presses
-- promote; that is how a release reaches beta, then prod, when the people
-- responsible say so. A fleet can instead promote itself as soon as its gate
-- opens (still waiting for a second person when it asks for approval).
ALTER TABLE fleets ADD COLUMN auto_promote BOOLEAN NOT NULL DEFAULT false;
