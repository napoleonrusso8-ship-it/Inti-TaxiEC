import { useEffect, useState } from 'react';
import { Security } from '@intitaxi/mobile-security';
import { useSession } from '../lib/session-context';
import { Button, Card, ErrorText, Field, P, Screen, useAction } from '../ui/kit';

/** PIN para cancelar una alerta y PIN de coacción (cancela en pantalla, la alerta sigue); contactos de confianza. */
export function Safety() {
  const { api } = useSession();
  const [pin, setPin] = useState('');
  const [duress, setDuress] = useState('');
  const [current, setCurrent] = useState('');
  const [contacts, setContacts] = useState<{ id: string; name: string; phone: string }[]>([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [info, setInfo] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const loadContacts = () => run(async () => setContacts(await api.trustedContacts()));
  useEffect(() => {
    void Security.setSecureScreen(true);
    void loadContacts();
    return () => void Security.setSecureScreen(false);
  }, []);
  return (
    <Screen title="Seguridad del viaje">
      <Card>
        <P style={{ fontWeight: '700' }}>PIN de seguridad</P>
        <P muted>Sirve para cancelar una alerta SOS. Si alguien te obliga a cancelarla, usa el PIN de emergencia: la app mostrará "cancelada" pero el centro de monitoreo seguirá atendiendo.</P>
        <Field label="PIN (4 a 6 dígitos)" value={pin} onChangeText={setPin} keyboardType="number-pad" secureTextEntry maxLength={6} />
        <Field label="PIN de emergencia (distinto)" value={duress} onChangeText={setDuress} keyboardType="number-pad" secureTextEntry maxLength={6} />
        <Field label="PIN actual (si ya tenías uno)" value={current} onChangeText={setCurrent} keyboardType="number-pad" secureTextEntry maxLength={6} />
        <Button label="Guardar PINs" loading={busy} disabled={pin.length < 4 || duress.length < 4 || pin === duress} onPress={() => run(async () => (await api.setSafetyPins(pin, duress, current || undefined), setInfo('PINs guardados'), setPin(''), setDuress(''), setCurrent('')))} />
      </Card>
      <Card>
        <P style={{ fontWeight: '700' }}>Contactos de confianza</P>
        <P muted>Reciben un SMS con tu ubicación si activas el SOS.</P>
        {contacts.map((c) => (
          <P key={c.id}>
            {c.name} · {c.phone}
          </P>
        ))}
        <Field label="Nombre" value={name} onChangeText={setName} maxLength={60} />
        <Field label="Celular" value={phone} onChangeText={setPhone} keyboardType="phone-pad" maxLength={10} />
        <Button label="Agregar contacto" kind="secondary" disabled={name.length < 2 || phone.length < 10} onPress={() => run(async () => (await api.addTrustedContact(name.trim(), phone.trim()), setName(''), setPhone(''), await loadContacts()))} />
      </Card>
      {info ? <P>{info}</P> : null}
      <ErrorText error={error} />
    </Screen>
  );
}
