-- Clientes web (panel de administración): sin atestación móvil; solo passkey.
ALTER TABLE identity.devices DROP CONSTRAINT devices_platform_check;
ALTER TABLE identity.devices ADD CONSTRAINT devices_platform_check CHECK (platform IN ('android', 'ios', 'web'));
ALTER TABLE identity.devices DROP CONSTRAINT devices_attestation_status_check;
ALTER TABLE identity.devices ADD CONSTRAINT devices_attestation_status_check CHECK (attestation_status IN ('passed', 'failed', 'not_applicable'));
