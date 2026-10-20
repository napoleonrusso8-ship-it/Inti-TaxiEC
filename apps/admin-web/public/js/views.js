// Pantallas del panel. Cada una declara los roles que la ven (la API vuelve a comprobarlos en cada petición:
// ocultar un menú NO es un control de seguridad).
import { ask, button, card, fmt, form, h, json, run, table, toast } from './ui.js';

/** Tipos de socio (app única). */
const PARTNER_KIND = { taxi_driver: 'Conductor de taxi', route_taxi_owner: 'Dueño de taxi amarillo (Ruta)', van_owner: 'Dueño de furgoneta (Ruta)', rental_company: 'Empresa de alquiler', tow_operator: 'Operador de grúa' };
const kindLabel = (k) => PARTNER_KIND[k] ?? k ?? '';

const statusSelect = (options, value, onchange) => h('select', { onchange: (e) => onchange(e.target.value) }, options.map((o) => h('option', { value: o, selected: o === value }, o)));

/** Vista con filtro de estado que se vuelve a pintar al cambiarlo. */
function filtered(root, options, initial, load) {
  let current = initial;
  const body = h('div');
  const refresh = async () => {
    body.replaceChildren(h('p', { class: 'muted' }, 'Cargando…'));
    body.replaceChildren(await load(current, refresh));
  };
  root.append(h('div', { class: 'toolbar' }, 'Estado: ', statusSelect(options, current, (v) => ((current = v), refresh())), button('Actualizar', refresh)), body);
  return refresh();
}

export const VIEWS = [
  {
    id: 'resumen',
    title: 'Resumen',
    roles: ['super_admin', 'driver_reviewer', 'support', 'fraud_analyst', 'sos_operator', 'route_manager', 'auditor', 'dpo', 'trust_safety'],
    async render(s, root) {
      const m = await s.call('api', 'GET', '/v1/admin/metrics');
      const stat = (label, value, warn) => h('div', { class: `stat ${warn ? 'warn' : ''}` }, h('span', { class: 'value' }, String(value)), h('span', { class: 'label' }, label));
      const incidents = Object.values(m.queues.incidentsActive).reduce((a, b) => a + b, 0);
      root.append(
        h('p', { class: 'muted' }, `Día ${m.day} (${m.timezone}). Solo cifras agregadas: el resumen no contiene datos personales.`),
        h('div', { class: 'stats' },
          stat('Incidentes SOS activos', incidents, incidents > 0),
          stat('Conductores conectados', m.driversOnline),
          stat('Disponibles para viajes', m.driversAvailable),
          stat('Vehículos en Taxi Ruta', m.routeVehiclesInService),
          stat('Ingresos de hoy', fmt.money(m.revenueTodayCents)),
          stat('Conductores por revisar', m.drivers.under_review ?? 0, (m.drivers.under_review ?? 0) > 0),
          stat('KYC duplicados', m.queues.kycDuplicateReview, m.queues.kycDuplicateReview > 0),
          stat('Señales de fraude', m.queues.fraudSignalsOpen, m.queues.fraudSignalsOpen > 0),
          stat('Retiros pendientes', m.queues.payoutsPending),
          stat('Disputas abiertas', m.queues.disputesOpen),
        ),
        card('Viajes de hoy', table(m.tripsToday, [{ label: 'Tipo', key: 'type' }, { label: 'Estado', key: 'status' }, { label: 'Cantidad', key: 'n' }])),
      );
    },
  },
  {
    id: 'conductores',
    title: 'Conductores',
    roles: ['driver_reviewer'],
    render(s, root) {
      return filtered(root, ['under_review', 'applicant', 'approved', 'rejected', 'suspended'], 'under_review', async (status) => {
        const rows = await s.call('api', 'GET', `/v1/admin/drivers?status=${status}`);
        return table(rows, [{ label: 'Socio', value: (r) => fmt.short(r.driverId) }, { label: 'Tipo', value: (r) => kindLabel(r.partnerKind) }, { label: 'Empresa', value: (r) => r.businessName ?? '' }, { label: 'Licencia', value: (r) => r.licenseCategory ?? '—' }, { label: 'Enviado', value: (r) => fmt.dt(r.submittedAt) }], (r) => button('Revisar', () => driverDetail(s, r.driverId)));
      });
    },
  },
  {
    id: 'kyc',
    title: 'KYC duplicados',
    roles: ['fraud_analyst'],
    async render(s, root) {
      const rows = await s.call('api', 'GET', '/v1/admin/kyc/reviews');
      root.append(
        h('p', { class: 'muted' }, 'Un documento ya aprobado en otra cuenta. "Rechazar" si parece suplantación; "Transferir" si es la misma persona con una cuenta nueva (la prueba de vida ya pasó). Ambas decisiones quedan auditadas.'),
        table(rows, [{ label: 'Verificación', value: (r) => fmt.short(r.id) }, { label: 'Documento', key: 'documentMasked' }, { label: 'Tipo', key: 'docType' }, { label: 'Riesgo', key: 'riskScore' }, { label: 'Otras cuentas', value: (r) => (r.conflictingAccounts ?? []).map((a) => fmt.short(a.userId)).join(', ') }, { label: 'Marcada', value: (r) => fmt.dt(r.flaggedAt) }], (r) => [
          button('Rechazar', () => decideKyc(s, r.id, 'reject'), 'danger'),
          button('Transferir', () => decideKyc(s, r.id, 'transfer')),
        ]),
      );
    },
  },
  {
    id: 'fraude',
    title: 'Fraude y retiros',
    roles: ['fraud_analyst'],
    async render(s, root) {
      const signals = await s.call('api', 'GET', '/v1/admin/fraud/signals?status=open');
      const payouts = await s.call('api', 'GET', '/v1/admin/payouts?status=requested');
      const review = await s.call('api', 'GET', '/v1/admin/payouts?status=under_review');
      root.append(
        card('Señales abiertas', table(signals, [{ label: 'Señal', key: 'signal' }, { label: 'Puntaje', key: 'score' }, { label: 'Sujeto', value: (r) => `${r.subject_type} ${fmt.short(r.subject_id)}` }, { label: 'Fecha', value: (r) => fmt.dt(r.created_at) }], (r) => [
          button('Confirmar', () => run(() => s.call('api', 'POST', `/v1/admin/fraud/signals/${r.id}`, { decision: 'confirmed' }), 'Señal confirmada').then(reload)),
          button('Descartar', () => run(() => s.call('api', 'POST', `/v1/admin/fraud/signals/${r.id}`, { decision: 'dismissed' }), 'Señal descartada').then(reload)),
        ])),
        card('Retiros', table([...payouts, ...review], [{ label: 'Retiro', value: (r) => fmt.short(r.id) }, { label: 'Conductor', value: (r) => fmt.short(r.driverId) }, { label: 'Monto', value: (r) => fmt.money(r.amountCents) }, { label: 'Estado', key: 'status' }, { label: 'Motivo de revisión', key: 'reviewReason' }], (r) => [
          button('Pagado', () => payout(s, r.id, 'paid')),
          button('Rechazar', () => payout(s, r.id, 'rejected'), 'danger'),
        ])),
      );
    },
  },
  {
    id: 'disputas',
    title: 'Disputas',
    roles: ['support'],
    render(s, root) {
      return filtered(root, ['open', 'in_review', 'resolved', 'rejected'], 'open', async (status) => {
        const rows = await s.call('api', 'GET', `/v1/admin/disputes?status=${status}`);
        return table(rows, [{ label: 'Disputa', value: (r) => fmt.short(r.id) }, { label: 'Categoría', key: 'category' }, { label: 'Abierta por', key: 'openerRole' }, { label: 'Viaje', value: (r) => `${r.tripType} ${fmt.money(r.fareCents)}` }, { label: 'Pago', key: 'paymentMethod' }, { label: 'Fecha', value: (r) => fmt.dt(r.createdAt) }], (r) => button('Abrir', () => disputeDetail(s, r.id)));
      });
    },
  },
  {
    id: 'sos',
    title: 'Incidentes SOS',
    roles: ['sos_operator'],
    render(s, root) {
      return filtered(root, ['active', 'cancelled_by_user', 'closed'], 'active', async (status) => {
        const rows = await s.call('sos', 'GET', `/v1/admin/incidents?status=${status}`);
        return table(rows, [{ label: 'Incidente', value: (r) => fmt.short(r.id) }, { label: 'Tipo', key: 'type' }, { label: 'Estado', key: 'status' }, { label: 'Severidad', value: (r) => h('span', { class: `badge ${r.severity}` }, r.severity) }, { label: 'Origen', key: 'openedBy' }, { label: 'ECU 911', key: 'ecu911' }, { label: 'Última ubicación', value: (r) => (r.lastLocation ? `${r.lastLocation.lat.toFixed(5)}, ${r.lastLocation.lng.toFixed(5)}` : '') }, { label: 'Abierto', value: (r) => fmt.dt(r.openedAt) }], (r) => button('Atender', () => incidentDetail(s, r.id)));
      });
    },
  },
  {
    id: 'rutas',
    title: 'Taxi Ruta',
    roles: ['route_manager'],
    async render(s, root) {
      const rows = await s.call('api', 'GET', '/v1/admin/routes');
      root.append(
        h('p', { class: 'muted' }, 'Publicar requiere validar y la aprobación de otra persona. Una ruta activa se pausa para editarla.'),
        table(rows, [{ label: 'Código', key: 'code' }, { label: 'Nombre', key: 'name' }, { label: 'Estado', value: (r) => h('span', { class: `badge ${r.status}` }, r.status) }, { label: 'Conductores', key: 'enabledDrivers' }, { label: 'En servicio', key: 'vehiclesInService' }], (r) => button('Gestionar', () => routeDetail(s, r.id))),
        await enablementRequests(s),
        card('Nueva ruta', form([{ name: 'code', label: 'Código (R2, R3…)', required: true, max: 4 }, { name: 'name', label: 'Nombre', required: true, max: 120 }, { name: 'corridor', label: 'Corredor (vías)', max: 300 }], 'Crear borrador', async (v) => {
          const r = await run(() => s.call('api', 'POST', '/v1/admin/routes', { code: v.code, name: v.name, corridor: v.corridor || undefined }), 'Ruta creada en borrador');
          if (r) routeDetail(s, r.id);
        })),
      );
    },
  },
  {
    id: 'privacidad',
    title: 'Privacidad (LOPDP)',
    roles: ['dpo'],
    render(s, root) {
      return filtered(root, ['received', 'deferred_legal_hold', 'completed', 'rejected'], 'deferred_legal_hold', async (status, refresh) => {
        const rows = await s.call('api', 'GET', `/v1/admin/privacy-requests?status=${status}`);
        return table(rows, [{ label: 'Solicitud', value: (r) => fmt.short(r.id) }, { label: 'Tipo', key: 'type' }, { label: 'Documento', key: 'documentMasked' }, { label: 'Retención legal', value: (r) => (r.legalHold ? 'Sí (viaje activo o incidente)' : 'No') }, { label: 'Vence', value: (r) => fmt.dt(r.dueAt) }, { label: 'Notas', key: 'notes' }], (r) =>
          ['received', 'deferred_legal_hold'].includes(r.status)
            ? [
                button('Completar', async () => {
                  const notes = ask('Notas para el expediente (base y acciones realizadas):');
                  if (notes && (await run(() => s.call('api', 'POST', `/v1/admin/privacy-requests/${r.id}/decision`, { decision: 'complete', notes }), 'Solicitud completada'))) refresh();
                }),
                button('Rechazar', async () => {
                  const notes = ask('Fundamento legal del rechazo:');
                  if (notes && (await run(() => s.call('api', 'POST', `/v1/admin/privacy-requests/${r.id}/decision`, { decision: 'reject', notes }), 'Solicitud rechazada'))) refresh();
                }, 'danger'),
              ]
            : null,
        );
      });
    },
  },
  {
    id: 'auditoria',
    title: 'Auditoría',
    roles: ['auditor'],
    async render(s, root) {
      const out = h('div');
      const verifyBox = h('div');
      const load = async (f, before) => {
        const q = new URLSearchParams(Object.entries({ ...f, before }).filter(([, v]) => v));
        const r = await s.call('api', 'GET', `/v1/admin/audit?${q}`);
        out.replaceChildren(
          table(r.entries, [{ label: '#', key: 'seq' }, { label: 'Fecha', value: (e) => fmt.dt(e.ts) }, { label: 'Acción', key: 'action' }, { label: 'Recurso', value: (e) => `${e.resourceType} ${e.resourceId ? fmt.short(e.resourceId) : ''}` }, { label: 'Actor', value: (e) => `${fmt.short(e.actorUserId)} ${e.actorRole ?? ''}` }, { label: 'Resultado', key: 'outcome' }, { label: 'Finalidad', key: 'purpose' }, { label: 'Metadatos', value: (e) => JSON.stringify(e.metadata) }]),
          r.nextBefore ? button('Más antiguos', () => load(f, r.nextBefore)) : null,
        );
      };
      root.append(
        card('Integridad de la cadena', h('p', { class: 'muted' }, 'Recalcula el hash encadenado de todo el log. Una alteración o borrado de cualquier fila rompe la cadena.'), button('Verificar ahora', async () => {
          const r = await run(() => s.call('api', 'POST', '/v1/admin/audit/verify'));
          if (r) verifyBox.replaceChildren(h('p', { class: r.intact ? 'ok' : 'error' }, r.intact ? `Íntegra: ${r.entries} entradas · cabeza ${r.headHash.slice(0, 16)}…` : `ROTA en la entrada #${r.firstBrokenSeq}`));
        }), verifyBox),
        card('Buscar', form([{ name: 'action', label: 'Acción (prefijo, p. ej. route.)' }, { name: 'resourceType', label: 'Tipo de recurso' }, { name: 'resourceId', label: 'ID del recurso' }, { name: 'actorUserId', label: 'ID del actor' }, { name: 'outcome', label: 'Resultado', type: 'select', options: ['', 'success', 'denied', 'failure'] }], 'Buscar', (v) => load(v))),
        out,
      );
      await load({});
    },
  },
  {
    id: 'roles',
    title: 'Roles',
    roles: ['super_admin'],
    async render(s, root) {
      const out = h('div');
      const show = async (userId) => {
        const rows = await s.call('api', 'GET', `/v1/admin/users/${userId}/roles`);
        out.replaceChildren(table(rows, [{ label: 'Rol', key: 'role' }, { label: 'Otorgado por', value: (r) => fmt.short(r.granted_by) }, { label: 'Fecha', value: (r) => fmt.dt(r.granted_at) }, { label: 'Expira', value: (r) => fmt.dt(r.expires_at) }], (r) =>
          button('Revocar', async () => {
            if (confirm(`¿Revocar ${r.role}?`) && (await run(() => s.call('api', 'DELETE', `/v1/admin/users/${userId}/roles/${r.role}`), 'Rol revocado'))) show(userId);
          }, 'danger'),
        ));
      };
      root.append(
        h('p', { class: 'muted' }, 'Mínimo privilegio: asigna roles con fecha de expiración. Nadie puede asignarse roles a sí mismo.'),
        card('Usuario', form([{ name: 'userId', label: 'ID de usuario', required: true }], 'Ver roles', (v) => run(() => show(v.userId)))),
        card('Asignar rol', form([{ name: 'userId', label: 'ID de usuario', required: true }, { name: 'role', label: 'Rol', type: 'select', options: ['driver_reviewer', 'support', 'fraud_analyst', 'sos_operator', 'route_manager', 'auditor', 'dpo', 'super_admin'] }, { name: 'expiresInDays', label: 'Expira en (días)', type: 'number', value: '90' }], 'Asignar', async (v) => {
          if (await run(() => s.call('api', 'POST', `/v1/admin/users/${v.userId}/roles`, { role: v.role, expiresInDays: v.expiresInDays }), 'Rol asignado')) show(v.userId);
        })),
        out,
      );
    },
  },
];

// ---------- Detalles (se abren en el panel lateral) ----------

let reload = () => {};
export function setReload(fn) {
  reload = fn;
}

function drawer(title, ...children) {
  const d = document.getElementById('drawer');
  d.replaceChildren(h('div', { class: 'drawer-head' }, h('h2', {}, title), button('Cerrar', () => d.classList.remove('open'))), ...children);
  d.classList.add('open');
  return d;
}

async function driverDetail(s, id) {
  const d = await run(() => s.call('api', 'GET', `/v1/admin/drivers/${id}`));
  if (!d) return;
  const docs = d.documents ?? [];
  drawer(
    `Socio ${fmt.short(id)}`,
    h('p', {}, h('strong', {}, kindLabel(d.partnerKind)), d.company ? ` · ${d.company.businessName} · RUC ${d.company.rucMasked}` : '', d.license ? ` · Licencia ${d.license.number} (${d.license.category})` : ''),
    h('p', { class: 'muted' }, `Documentos exigidos: ${(d.requiredDocs?.personal ?? []).join(', ')} + por vehículo ${(d.requiredDocs?.vehicle ?? []).join(', ')}`),
    d.issuesForApproval?.length ? h('p', { class: 'error' }, `Pendiente: ${d.issuesForApproval.join(', ')}`) : h('p', { class: 'ok' }, 'Sin pendientes para aprobar'),
    card('Documentos', table(docs, [{ label: 'Tipo', key: 'type' }, { label: 'Estado', key: 'status' }, { label: 'Vence', key: 'expiresOn' }], (doc) => [
      button('Ver (60 s)', async () => {
        const reason = ask('Motivo de la consulta (queda en la auditoría):', 10);
        const r = reason && (await run(() => s.call('api', 'POST', `/v1/admin/drivers/${id}/documents/${doc.id}/view-url`, { reason })));
        if (r) window.open(r.url, '_blank', 'noopener,noreferrer');
      }),
      button('Aprobar', async () => {
        let confirmedSeats;
        if (doc.type === 'registration') {
          const n = prompt('¿Cuántos asientos para pasajeros indica la matrícula?');
          if (n === null) return;
          confirmedSeats = Number(n);
        }
        await run(() => s.call('api', 'POST', `/v1/admin/drivers/${id}/documents/${doc.id}/review`, { decision: 'approved', ...(confirmedSeats ? { confirmedSeats } : {}) }), 'Documento aprobado').then(() => driverDetail(s, id));
      }),
      button('Rechazar', async () => {
        const reason = ask('Motivo del rechazo:');
        if (reason) await run(() => s.call('api', 'POST', `/v1/admin/drivers/${id}/documents/${doc.id}/review`, { decision: 'rejected', reason }), 'Documento rechazado').then(() => driverDetail(s, id));
      }, 'danger'),
    ])),
    card('Decisión', form([{ name: 'decision', label: 'Decisión', type: 'select', options: [{ value: 'approve', label: 'Aprobar' }, { value: 'reject', label: 'Rechazar' }, { value: 'suspend', label: 'Suspender' }] }, { name: 'reason', label: 'Motivo', required: true }], 'Registrar', async (v) => {
      if (await run(() => s.call('api', 'POST', `/v1/admin/drivers/${id}/decision`, v), 'Decisión registrada')) reload();
    })),
    json(d),
  );
}

async function decideKyc(s, id, decision) {
  const reason = ask(decision === 'reject' ? 'Motivo del rechazo:' : 'Justificación (¿cómo se confirmó que es la misma persona?):');
  if (reason && (await run(() => s.call('api', 'POST', `/v1/admin/kyc/reviews/${id}/decision`, { decision, reason }), 'Decisión registrada'))) reload();
}

async function payout(s, id, decision) {
  const reason = ask(decision === 'paid' ? 'Referencia de la transferencia:' : 'Motivo del rechazo:', 3);
  if (reason && (await run(() => s.call('api', 'POST', `/v1/admin/payouts/${id}/decision`, { decision, reason }), 'Retiro actualizado'))) reload();
}

async function disputeDetail(s, id) {
  const reason = ask('Motivo para abrir el reclamo (queda en la auditoría):');
  if (!reason) return;
  const d = await run(() => s.call('api', 'GET', `/v1/admin/disputes/${id}?reason=${encodeURIComponent(reason)}`));
  if (!d) return;
  const open = ['open', 'in_review'].includes(d.status);
  drawer(
    `Disputa ${fmt.short(id)} · ${d.category}`,
    card('Relato del usuario', h('p', { class: 'quote' }, d.description)),
    card('Viaje y pago', json({ trip: d.trip, payment: d.payment })),
    open ? button('Asignarme', () => run(() => s.call('api', 'POST', `/v1/admin/disputes/${id}/assign`), 'Asignada').then(reload)) : null,
    open
      ? card('Resolver', form([
          { name: 'decision', label: 'Decisión', type: 'select', options: [{ value: 'resolved', label: 'A favor del usuario' }, { value: 'rejected', label: 'Rechazar' }] },
          { name: 'resolution', label: 'Resolución', type: 'textarea', required: true, max: 500 },
          { name: 'refundCents', label: 'Reembolso (centavos, opcional)', type: 'number' },
          { name: 'refundTo', label: 'Reembolsar a', type: 'select', options: [{ value: 'original', label: 'Medio de pago original' }, { value: 'wallet', label: 'Billetera' }] },
        ], 'Cerrar disputa', async (v) => {
          const body = { decision: v.decision, resolution: v.resolution, ...(v.refundCents ? { refundCents: v.refundCents, refundTo: v.refundTo } : {}) };
          if (await run(() => s.call('api', 'POST', `/v1/admin/disputes/${id}/resolve`, body), 'Disputa cerrada')) {
            document.getElementById('drawer').classList.remove('open');
            reload();
          }
        }))
      : card('Resolución', json({ status: d.status, resolution: d.resolution, refundCents: d.refundCents })),
  );
}

async function incidentDetail(s, id) {
  const d = await run(() => s.call('sos', 'GET', `/v1/admin/incidents/${id}`));
  if (!d) return;
  const inc = d.incident;
  const m = d.manifest;
  const act = (path, body, msg) => run(() => s.call('sos', 'POST', `/v1/admin/incidents/${id}/${path}`, body), msg).then(() => incidentDetail(s, id)).then(reload);
  drawer(
    `Incidente ${fmt.short(id)} · ${inc.type} · ${inc.status}`,
    inc.duress ? h('p', { class: 'error' }, 'PIN DE COACCIÓN: la persona "canceló" bajo amenaza. Mantener la alerta.') : null,
    h('div', { class: 'toolbar' },
      button('Atender', () => act('acknowledge', undefined, 'Incidente atendido')),
      button('Escalar a ECU 911', () => confirm('¿Enviar el manifiesto y la ubicación al ECU 911?') && act('escalate', undefined, 'Escalado al ECU 911'), 'danger'),
      button('Cerrar', () => {
        const resolution = ask('Resolución del incidente:');
        if (resolution) act('close', { resolution, legalHoldDays: 90 }, 'Incidente cerrado');
      }),
    ),
    card(`Manifiesto (${m?.integrity ?? 'sin manifiesto'})`, m?.integrity === 'TAMPERED' ? h('p', { class: 'error' }, 'La cadena de versiones del manifiesto NO es íntegra.') : null, json(m?.payload ?? null)),
    card('Eventos', table(d.events, [{ label: 'Evento', key: 'event' }, { label: 'Fecha', value: (e) => fmt.dt(e.at ?? e.created_at) }, { label: 'Datos', value: (e) => JSON.stringify(e.data ?? {}) }])),
  );
}

/** Solicitudes de habilitación hechas desde la app por dueños de taxi amarillo y de furgoneta. */
async function enablementRequests(s) {
  const rows = await s.call('api', 'GET', '/v1/admin/routes/enablement-requests?status=pending');
  const decide = async (r, approve) => {
    const reason = approve ? undefined : ask('Motivo del rechazo (lo verá el socio):');
    if (!approve && !reason) return;
    if (await run(() => s.call('api', 'POST', `/v1/admin/routes/enablement-requests/${r.id}/decision`, { approve, reason }), approve ? 'Socio habilitado en la ruta' : 'Solicitud rechazada')) reload();
  };
  return card('Solicitudes de habilitación desde la app',
    rows.length
      ? table(rows, [{ label: 'Ruta', key: 'routeCode' }, { label: 'Socio', value: (r) => `${r.driverFirstName ?? ''} (${fmt.short(r.driverId)})` }, { label: 'Tipo', value: (r) => kindLabel(r.partnerKind) }, { label: 'Vehículo', value: (r) => `${r.plate} · ${r.vehicleType} · ${r.seats} asientos` }, { label: 'Pedida', value: (r) => fmt.dt(r.createdAt) }], (r) => [
          button('Aprobar', () => decide(r, true)),
          button('Rechazar', () => decide(r, false), 'danger'),
        ])
      : h('p', { class: 'muted' }, 'No hay solicitudes pendientes.'));
}

async function routeDetail(s, id) {
  const r = await run(() => s.call('api', 'GET', `/v1/admin/routes/${id}`));
  if (!r) return;
  const editable = ['draft', 'paused'].includes(r.status);
  const call = (method, path, body, msg) => run(() => s.call('api', method, `/v1/admin/routes/${id}${path}`, body), msg).then((x) => (x !== undefined && routeDetail(s, id), reload(), x));
  const stopsCsv = (d) => d.stops.map((x) => `${x.name};${x.lat};${x.lng}`).join('\n');
  const parseStops = (txt, prev) =>
    txt.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [name, lat, lng] = l.split(';').map((x) => x.trim());
      const same = prev.find((p) => p.name === name);
      return { stopId: same?.id, name, lat: Number(lat), lng: Number(lng), locationVerified: same?.locationVerified ?? false };
    });
  drawer(
    `${r.code} · ${r.name}`,
    h('p', {}, h('span', { class: `badge ${r.status}` }, r.status), ` ${r.corridor ?? ''}`),
    h('div', { class: 'toolbar' },
      button('Validar con mapas', async () => {
        const v = await call('POST', '/validate', undefined);
        if (v) toast(v.ok ? 'Validación correcta (revisa las advertencias)' : 'La validación encontró problemas', v.ok ? 'ok' : 'error');
      }),
      editable ? button('Solicitar publicación', () => call('POST', '/publish-request', undefined, 'Publicación solicitada')) : null,
      r.status === 'pending_approval' ? button('Aprobar publicación', () => call('POST', '/publish-decision', { approve: true }, 'Ruta publicada')) : null,
      r.status === 'pending_approval' ? button('Rechazar publicación', () => call('POST', '/publish-decision', { approve: false }, 'Publicación rechazada'), 'danger') : null,
      r.status === 'active' ? button('Pausar', () => {
        const reason = ask('Motivo de la pausa:');
        if (reason) call('POST', '/pause', { reason }, 'Ruta pausada');
      }, 'danger') : null,
    ),
    card('Tarifas por persona (hora de Guayaquil, se fijan al subir)', table(r.fares, [{ label: 'Franja', key: 'name' }, { label: 'Desde', key: 'from' }, { label: 'Hasta', key: 'to' }, { label: 'Monto', value: (f) => fmt.money(f.amountCents) }]),
      editable ? form([{ name: 'day', label: 'Diurna 06:30–21:00 (centavos)', type: 'number', value: String(r.fares.find((f) => f.from === '06:30')?.amountCents ?? 300) }, { name: 'night', label: 'Nocturna 21:00–06:30 (centavos)', type: 'number', value: String(r.fares.find((f) => f.from === '21:00')?.amountCents ?? 400) }], 'Guardar tarifas', (v) =>
        call('PUT', '/fares', { rules: [{ name: 'Diurna', startLocal: '06:30', endLocal: '21:00', amountCents: v.day }, { name: 'Nocturna', startLocal: '21:00', endLocal: '06:30', amountCents: v.night }] }, 'Tarifas guardadas'),
      ) : null),
    ...r.directions.map((d) =>
      card(`${d.direction === 'outbound' ? 'Ida' : 'Vuelta'}: ${d.label}`,
        table(d.stops, [{ label: '#', key: 'seq' }, { label: 'Parada', key: 'name' }, { label: 'Coordenadas', value: (x) => `${x.lat}, ${x.lng}` }, { label: 'Verificada', value: (x) => (x.locationVerified ? 'Sí' : 'No') }]),
        d.validationReport ? h('details', {}, h('summary', {}, `Informe de validación: ${(d.validationReport.warnings ?? []).length} advertencia(s)`), h('ul', {}, (d.validationReport.warnings ?? []).map((w) => h('li', {}, w))), json(d.validationReport.stopOrder)) : h('p', { class: 'muted' }, 'Sin validar'),
        editable ? form([{ name: 'stops', label: 'Paradas en orden (una por línea: nombre;lat;lng)', type: 'textarea', value: stopsCsv(d), max: 6000 }], 'Guardar paradas', (v) => call('PUT', `/directions/${d.direction}/stops`, { stops: parseStops(v.stops, d.stops) }, 'Paradas guardadas')) : null,
      ),
    ),
    card('Conductores habilitados', form([{ name: 'driverId', label: 'ID del conductor', required: true }], 'Habilitar', (v) => call('POST', '/drivers', { driverId: v.driverId }, 'Conductor habilitado'))),
  );
}
