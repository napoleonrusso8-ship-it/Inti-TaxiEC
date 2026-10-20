import { Pressable, Switch, Text, View } from 'react-native';
import { emptyPerson, type PersonDraft } from '../lib/people';
import { C, Card, Choice, Field, P, Row } from '../ui/kit';

export { emptyPerson, personProblem, toPerson, type PersonDraft } from '../lib/people';

export function PersonFields({ value, onChange, title, needsPhone, allowMinor }: { value: PersonDraft; onChange: (p: PersonDraft) => void; title: string; needsPhone?: boolean; allowMinor?: boolean }) {
  const set = (k: keyof PersonDraft) => (v: string | boolean) => onChange({ ...value, [k]: v });
  return (
    <Card>
      <P style={{ fontWeight: '700' }}>{title}</P>
      <Field label="Nombres" value={value.givenNames} onChangeText={set('givenNames')} autoCapitalize="words" maxLength={80} />
      <Field label="Apellidos" value={value.familyNames} onChangeText={set('familyNames')} autoCapitalize="words" maxLength={80} />
      <Choice value={value.idType} onChange={set('idType') as (v: 'cedula' | 'passport') => void} options={[{ value: 'cedula', label: 'Cédula' }, { value: 'passport', label: 'Pasaporte' }]} />
      <Field label={value.idType === 'cedula' ? 'Número de cédula' : 'Número de pasaporte'} value={value.idNumber} onChangeText={set('idNumber')} keyboardType={value.idType === 'cedula' ? 'number-pad' : 'default'} maxLength={20} autoCapitalize="characters" />
      {allowMinor ? (
        <Row>
          <Switch value={value.isMinor} onValueChange={set('isMinor')} />
          <P>Es menor de edad (viaja conmigo)</P>
        </Row>
      ) : null}
      {!value.isMinor ? <Field label="Correo" value={value.email} onChangeText={set('email')} keyboardType="email-address" autoCapitalize="none" maxLength={120} /> : null}
      {needsPhone ? <Field label="Celular" value={value.phone} onChangeText={set('phone')} keyboardType="phone-pad" maxLength={10} /> : null}
    </Card>
  );
}

/** Lista de acompañantes: cada persona adicional se registra (sección 5.1). */
export function CompanionsEditor({ people, onChange, max }: { people: PersonDraft[]; onChange: (p: PersonDraft[]) => void; max: number }) {
  return (
    <View style={{ gap: 10 }}>
      {people.map((p, i) => (
        <View key={i} style={{ gap: 6 }}>
          <PersonFields title={`Acompañante ${i + 1}`} value={p} allowMinor onChange={(np) => onChange(people.map((x, j) => (j === i ? np : x)))} />
          <Pressable onPress={() => onChange(people.filter((_, j) => j !== i))}>
            <Text style={{ color: C.danger }}>Quitar acompañante {i + 1}</Text>
          </Pressable>
        </View>
      ))}
      {people.length < max ? (
        <Pressable onPress={() => onChange([...people, emptyPerson()])}>
          <Text style={{ color: C.accent, fontWeight: '600' }}>+ Agregar acompañante</Text>
        </Pressable>
      ) : null}
      <P muted>Cada acompañante recibe un aviso de privacidad por correo. Su cédula se guarda cifrada y se muestra enmascarada.</P>
    </View>
  );
}
