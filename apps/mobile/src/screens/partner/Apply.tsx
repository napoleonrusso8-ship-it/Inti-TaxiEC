import { useEffect, useState } from 'react';
import { PARTNER_KINDS, type PartnerKind } from '@intitaxi/mobile-core';
import { useNav } from '../../lib/nav';
import { useSession } from '../../lib/session-context';
import { Button, C, Card, Choice, ErrorText, Field, IconCircle, ListItem, Loading, P, Pill, Row, Screen, Section, useAction } from '../../ui/kit';

const LICENSE_CATEGORIES = ['C', 'C1', 'D', 'D1', 'E', 'E1'];
const isoDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
/** RUC ecuatoriano: 13 dígitos, provincia 01–24 o 30, termina en 001 (el servidor hace la validación completa). */
const rucLooksValid = (v: string) => /^\d{13}$/.test(v) && v.endsWith('001') && ((Number(v.slice(0, 2)) >= 1 && Number(v.slice(0, 2)) <= 24) || v.startsWith('30'));

/** Paso 1 del alta de socio: identidad verificada y datos de licencia (o de la empresa). */
export function PartnerApply({ kind }: { kind: PartnerKind }) {
  const { api, partner } = useSession();
  const nav = useNav();
  const meta = PARTNER_KINDS.find((k) => k.kind === kind)!;
  const [kyc, setKyc] = useState<string | null | undefined>(undefined);
  const [license, setLicense] = useState('');
  const [category, setCategory] = useState('C');
  const [expires, setExpires] = useState('');
  const [business, setBusiness] = useState('');
  const [ruc, setRuc] = useState('');
  const { busy, error, setError, run } = useAction();

  const loadKyc = () => api.kycStatus().then((r) => setKyc(r.verification?.status ?? null), () => setKyc(null));
  useEffect(() => void loadKyc(), []);

  const submit = () => {
    if (meta.needsLicense) {
      if (license.trim().length < 6) return setError('Escribe el número de tu licencia');
      if (!isoDate(expires)) return setError('Escribe la fecha de vencimiento como AAAA-MM-DD');
    } else {
      if (business.trim().length < 3) return setError('Escribe la razón social de la empresa');
      if (!rucLooksValid(ruc.trim())) return setError('El RUC debe tener 13 dígitos y terminar en 001');
    }
    void run(async () => {
      await partner.ensure();
      await partner.api.apply(
        meta.needsLicense
          ? { partnerKind: kind, licenseNumber: license.trim(), licenseCategory: category, licenseExpiresOn: expires }
          : { partnerKind: kind, company: { businessName: business.trim(), ruc: ruc.trim() } },
      );
      nav.reset('work');
    });
  };

  if (kyc === undefined) return <Screen title={meta.title}><Loading /></Screen>;
  return (
    <Screen title={meta.title} subtitle="Paso 1 de 3 · Tus datos">
      <Row>
        <IconCircle icon={meta.icon} size={52} />
        <P style={{ flex: 1 }}>{meta.subtitle}</P>
      </Row>
      <Section>Identidad</Section>
      <Card>
        <ListItem
          icon="🪪"
          title="Verificación con cédula y selfie"
          subtitle={kyc === 'approved' ? 'Lista' : 'Obligatoria para todos los socios'}
          right={kyc === 'approved' ? <Pill tone="ok">Verificada</Pill> : <Pill>Pendiente</Pill>}
          onPress={kyc === 'approved' ? undefined : () => nav.push('verify')}
        />
        {kyc !== 'approved' ? <Button label="Ya me verifiqué, actualizar" kind="ghost" small onPress={() => void loadKyc()} /> : null}
      </Card>
      {meta.needsLicense ? (
        <>
          <Section>Licencia profesional</Section>
          <Card>
            <Field label="Número de licencia" value={license} onChangeText={setLicense} autoCapitalize="characters" maxLength={20} />
            <P muted>Categoría</P>
            <Choice value={category} onChange={setCategory} options={LICENSE_CATEGORIES.map((c) => ({ value: c, label: c }))} />
            <Field label="Vence el" placeholder="AAAA-MM-DD" value={expires} onChangeText={setExpires} maxLength={10} keyboardType="numbers-and-punctuation" />
            {kind === 'van_owner' ? <P muted>Para furgonetas de más de 8 pasajeros normalmente se exige licencia D o E. Revisaremos tu categoría.</P> : null}
          </Card>
        </>
      ) : (
        <>
          <Section>Empresa</Section>
          <Card>
            <Field label="Razón social" value={business} onChangeText={setBusiness} maxLength={120} />
            <Field label="RUC" value={ruc} onChangeText={setRuc} keyboardType="number-pad" maxLength={13} hint="13 dígitos. Después subirás el certificado del RUC." />
            <P muted>Quien se registra (tú) actúa como representante de la empresa y responde por los vehículos publicados.</P>
          </Card>
        </>
      )}
      <ErrorText error={error} />
      <Button label="Continuar" onPress={submit} loading={busy} disabled={kyc !== 'approved'} />
      {kyc !== 'approved' ? <P muted center style={{ color: C.muted }}>Primero verifica tu identidad.</P> : null}
    </Screen>
  );
}
