-- 13: los perfiles anteriores a los tipos de socio quedaron como 'taxi_driver'. Quien solo tiene furgonetas o
-- solo grúas pasa a su tipo, para que sus vehículos sigan contando en la elegibilidad.
-- Los proveedores de alquiler anteriores NO se migran solos: la empresa de alquiler exige razón social y RUC
-- (y el certificado del RUC), así que deben volver a enviar la solicitud como empresa.
UPDATE drivers.profiles p SET partner_kind = k.kind, updated_at = now()
FROM (
  SELECT driver_id, min(vehicle_type) AS vt FROM drivers.vehicles WHERE status <> 'inactive' GROUP BY driver_id HAVING count(DISTINCT vehicle_type) = 1
) v
CROSS JOIN LATERAL (SELECT CASE v.vt WHEN 'van' THEN 'van_owner' WHEN 'tow' THEN 'tow_operator' END AS kind) k
WHERE p.user_id = v.driver_id AND p.partner_kind = 'taxi_driver' AND k.kind IS NOT NULL;
