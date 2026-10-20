import { useState } from 'react';
import { Alert, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { DOC_LABEL, issueLabel, PARTNER_KINDS, type DocType, type PartnerDocument, type PartnerProfile, type PartnerVehicle, type VehicleKind } from '@intitaxi/mobile-core';
import { useNav } from '../../lib/nav';
import { usePartner } from '../../lib/session-context';
import { readFile, sendFile } from '../../lib/upload';
import { Button, C, Card, Choice, ErrorText, Field, ListItem, P, Pill, Screen, Section, useAction } from '../../ui/kit';

const STATUS: Record<string, { label: string; tone: 'brand' | 'ok' | 'danger' | 'muted' }> = {
  applicant: { label: 'Completa tu registro', tone: 'brand' },
  submitted: { label: 'En revisión', tone: 'brand' },
  under_review: { label: 'En revisión', tone: 'brand' },
  approved: { label: 'Aprobado', tone: 'ok' },
  rejected: { label: 'Rechazado', tone: 'danger' },
  suspended: { label: 'Suspendido', tone: 'danger' },
};
const NEEDS_EXPIRY: DocType[] = ['license', 'insurance', 'registration'];

/** Estado de un documento para mostrarlo en la lista. */
function docState(d: PartnerDocument | undefined): { text: string; tone: 'ok' | 'brand' | 'danger' | 'muted' } {
  if (!d) return { text: 'Falta', tone: 'muted' };
  if (d.reviewStatus === 'rejected') return { text: 'Rechazado', tone: 'danger' };
  if (d.scanStatus === 'infected' || d.scanStatus === 'invalid') return { text: 'Archivo no válido', tone: 'danger' };
  if (d.reviewStatus === 'approved') return { text: 'Aprobado', tone: 'ok' };
  return { text: 'Enviado', tone: 'brand' };
}
const latest = (docs: PartnerDocument[], type: DocType, vehicleId: string | null) => docs.filter((d) => d.type === type && d.vehicleId === vehicleId && d.uploadStatus === 'uploaded').at(-1);

/** Pasos 2 y 3 del alta: documentos personales (o de la empresa), vehículos con sus documentos, y envío a revisión. */
export function PartnerSetup({ profile, reload }: { profile: PartnerProfile; reload: () => Promise<unknown> }) {
  const { api } = usePartner();
  const nav = useNav();
  const meta = PARTNER_KINDS.find((k) => k.kind === profile.partnerKind)!;
  const { busy, error, run } = useAction();
  const editable = ['applicant', 'rejected'].includes(profile.status);
  const st = STATUS[profile.status] ?? { label: profile.status, tone: 'muted' as const };

  const docRow = (type: DocType, vehicleId: string | null) => {
    const d = latest(profile.documents, type, vehicleId);
    const state = docState(d);
    return (
      <View key={`${type}-${vehicleId}`}>
        <ListItem
          icon={type === 'company_ruc' ? '🏢' : type === 'insurance' ? '🛡️' : type === 'registration' ? '📄' : type === 'background_check' ? '⚖️' : '🪪'}
          title={DOC_LABEL[type]}
          subtitle={d?.rejectionReason ? `Motivo: ${d.rejectionReason}` : d?.expiresOn ? `Vence ${d.expiresOn}` : undefined}
          right={<Pill tone={state.tone}>{state.text}</Pill>}
          onPress={editable || d?.reviewStatus === 'rejected' ? () => nav.push('partner.doc', { type, vehicleId }) : undefined}
        />
      </View>
    );
  };

  return (
    <>
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Text style={{ fontSize: 26 }}>{meta.icon}</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ color: C.ink, fontSize: 16, fontWeight: '700' }}>{meta.title}</Text>
            {profile.company ? <P muted>{profile.company.businessName} · RUC {profile.company.rucMasked}</P> : null}
          </View>
          <Pill tone={st.tone}>{st.label}</Pill>
        </View>
        {profile.decisionReason && profile.status === 'rejected' ? <P style={{ color: C.danger }}>Motivo: {profile.decisionReason}</P> : null}
        {['submitted', 'under_review'].includes(profile.status) ? <P muted>Un revisor de Inti Taxi está validando tus documentos y tu vehículo. Te avisaremos por SMS.</P> : null}
      </Card>

      <Section>{profile.partnerKind === 'rental_company' ? 'Documentos de la empresa' : 'Tus documentos'}</Section>
      <Card style={{ paddingVertical: 6 }}>{profile.requiredDocs.personal.map((t) => docRow(t, null))}</Card>

      <Section right={editable ? <Button label="+ Agregar" kind="ghost" small onPress={() => nav.push('partner.vehicle', { types: profile.allowedVehicleTypes })} /> : undefined}>Vehículos</Section>
      {profile.vehicles.length === 0 ? (
        <Card>
          <P muted>Registra tu {meta.vehicle === 'van' ? 'furgoneta' : meta.vehicle === 'rental' ? 'primer vehículo de alquiler' : meta.vehicle === 'tow' ? 'grúa' : 'taxi'} para continuar.</P>
          <Button label="Registrar vehículo" kind="secondary" onPress={() => nav.push('partner.vehicle', { types: profile.allowedVehicleTypes })} />
        </Card>
      ) : null}
      {profile.vehicles.map((v) => (
        <VehicleCard key={v.id} v={v}>
          {profile.requiredDocs.vehicle.map((t) => docRow(t, v.id))}
        </VehicleCard>
      ))}

      {profile.issues?.length && editable ? (
        <Card>
          <Section>Te falta</Section>
          {profile.issues.map((i) => (
            <P key={i} muted>
              • {issueLabel(i)}
            </P>
          ))}
        </Card>
      ) : null}
      <ErrorText error={error} />
      {editable ? (
        <Button
          label="Enviar a revisión"
          loading={busy}
          onPress={() =>
            run(async () => {
              await api.submit();
              await reload();
              Alert.alert('¡Listo!', 'Recibimos tu solicitud. Un revisor validará tus documentos.');
            })
          }
        />
      ) : null}
    </>
  );
}

export function VehicleCard({ v, children }: { v: PartnerVehicle; children?: React.ReactNode }) {
  const tone = v.status === 'approved' ? 'ok' : v.status === 'rejected' ? 'danger' : 'brand';
  return (
    <Card style={{ paddingVertical: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ backgroundColor: C.ink, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text style={{ color: '#111', fontWeight: '800', letterSpacing: 1 }}>{v.plate}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: C.ink, fontWeight: '600' }}>
            {v.make} {v.model} {v.year}
          </Text>
          <P muted>
            {v.color} · {v.seats_passenger} asientos{v.seats_verified ? ' (verificados)' : ''}
          </P>
        </View>
        <Pill tone={tone}>{v.status === 'approved' ? 'Aprobado' : v.status === 'rejected' ? 'Rechazado' : 'En revisión'}</Pill>
      </View>
      {children}
    </Card>
  );
}

const VEHICLE_LABEL: Record<VehicleKind, string> = { taxi: 'Taxi', van: 'Furgoneta', tow: 'Grúa', rental: 'Vehículo de alquiler' };
const SEATS: Record<VehicleKind, [number, number]> = { taxi: [1, 4], van: [5, 15], tow: [1, 2], rental: [1, 8] };

/** Registrar un vehículo (el tipo depende del perfil del socio). */
export function AddVehicle({ types }: { types: VehicleKind[] }) {
  const { api } = usePartner();
  const nav = useNav();
  const [type, setType] = useState<VehicleKind>(types[0] ?? 'taxi');
  const [plate, setPlate] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [color, setColor] = useState('');
  const [seats, setSeats] = useState(String(SEATS[types[0] ?? 'taxi'][1]));
  const [category, setCategory] = useState('auto');
  const { busy, error, setError, run } = useAction();
  const [min, max] = SEATS[type];

  const save = () => {
    const n = Number(seats);
    if (!/^[A-Za-z]{3}[\s-]?\d{3,4}$/.test(plate.trim())) return setError('Placa ecuatoriana: ABC-1234');
    if (!(n >= min && n <= max)) return setError(`${VEHICLE_LABEL[type]}: entre ${min} y ${max} asientos para pasajeros`);
    if (!/^\d{4}$/.test(year)) return setError('Año de 4 dígitos');
    void run(async () => {
      await api.addVehicle({ plate: plate.trim(), make: make.trim(), model: model.trim(), year: Number(year), color: color.trim(), seats: n, vehicleType: type, rentalCategory: type === 'rental' ? category : undefined });
      nav.back();
    });
  };

  return (
    <Screen title="Registrar vehículo" subtitle="Paso 2 de 3 · Vehículo y documentos">
      {types.length > 1 ? <Choice value={type} onChange={(t) => (setType(t), setSeats(String(SEATS[t][1])))} options={types.map((t) => ({ value: t, label: VEHICLE_LABEL[t] }))} /> : null}
      <Card>
        <Field label="Placa" placeholder="GBA-1234" value={plate} onChangeText={setPlate} autoCapitalize="characters" maxLength={8} />
        <Field label="Marca" value={make} onChangeText={setMake} maxLength={40} />
        <Field label="Modelo" value={model} onChangeText={setModel} maxLength={40} />
        <Field label="Año" value={year} onChangeText={setYear} keyboardType="number-pad" maxLength={4} />
        <Field label="Color" value={color} onChangeText={setColor} maxLength={30} />
        <Field label={`Asientos para pasajeros (${min}–${max})`} value={seats} onChangeText={setSeats} keyboardType="number-pad" maxLength={2} hint="Un revisor confirma la cantidad con la matrícula." />
        {type === 'rental' ? (
          <>
            <P muted>Categoría</P>
            <Choice value={category} onChange={setCategory} options={['auto', 'suv', 'camioneta', 'furgoneta'].map((c) => ({ value: c, label: c[0]!.toUpperCase() + c.slice(1) }))} />
          </>
        ) : null}
      </Card>
      <ErrorText error={error} />
      <Button label="Guardar vehículo" onPress={save} loading={busy} />
    </Screen>
  );
}

/** Subir un documento: foto con la cámara o desde la galería. El servidor revisa el archivo antes de aceptarlo. */
export function UploadDoc({ type, vehicleId }: { type: DocType; vehicleId: string | null }) {
  const { api } = usePartner();
  const nav = useNav();
  const [expires, setExpires] = useState('');
  const { busy, error, setError, run } = useAction();
  const needsExpiry = NEEDS_EXPIRY.includes(type);

  const pick = (source: 'camera' | 'library') =>
    run(async () => {
      if (needsExpiry && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) return setError('Escribe la fecha de vencimiento (AAAA-MM-DD)');
      if (source === 'camera' && !(await ImagePicker.requestCameraPermissionsAsync()).granted) return setError('Permite la cámara para fotografiar el documento');
      const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.8, exif: false };
      const r = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
      const a = r.canceled ? null : r.assets[0];
      if (!a) return;
      const contentType = a.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
      const f = await readFile(a.uri);
      const u = await api.documentUploadUrl({ type, vehicleId: vehicleId ?? undefined, contentType, size: f.size, sha256: f.sha256, expiresOn: needsExpiry ? expires : undefined });
      await sendFile(u.upload, a.uri, f.blob, contentType);
      const done = await api.documentComplete(u.documentId);
      if (done.scanStatus === 'infected' || done.scanStatus === 'invalid') return setError('El archivo no pasó la revisión de seguridad. Toma una foto nueva del documento.');
      nav.back();
    });

  return (
    <Screen title={DOC_LABEL[type]} subtitle="Foto nítida, completa y sin reflejos">
      <Card>
        <P muted>Tu documento se guarda cifrado. Solo lo ve el revisor de Inti Taxi, con un enlace que caduca en 60 segundos y queda registrado.</P>
        {needsExpiry ? <Field label="Fecha de vencimiento" placeholder="AAAA-MM-DD" value={expires} onChangeText={setExpires} maxLength={10} keyboardType="numbers-and-punctuation" /> : null}
      </Card>
      <ErrorText error={error} />
      <Button label="📷 Tomar foto" onPress={() => void pick('camera')} loading={busy} />
      <Button label="Elegir de la galería" kind="secondary" onPress={() => void pick('library')} disabled={busy} />
    </Screen>
  );
}
