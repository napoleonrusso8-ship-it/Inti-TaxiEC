import { useEffect, useState } from 'react';
import { Pressable, Text } from 'react-native';
import type { ChatMessage } from '@intitaxi/mobile-core';
import { useNav } from '../lib/nav';
import { useSession } from '../lib/session-context';
import { Button, C, Card, Choice, ErrorText, Field, P, Screen, useAction } from '../ui/kit';

const CATEGORIES = [
  { value: 'mistreatment', label: 'Malos tratos' },
  { value: 'discrimination', label: 'Discriminación' },
  { value: 'harassment', label: 'Acoso' },
  { value: 'threats', label: 'Amenazas' },
  { value: 'unsafe_driving', label: 'Conducción peligrosa' },
  { value: 'other', label: 'Otro' },
] as const;
type Category = (typeof CATEGORIES)[number]['value'];
const KIND_LABEL = { voice: '🎤 Nota de voz', photo: '📷 Foto', video: '🎬 Video' } as const;

/**
 * Reportar al conductor. Un agente de Confianza y Seguridad revisa el caso, contacta a ambas partes
 * y solo sanciona si hay pruebas (chat del viaje, archivos marcados, GPS). El chat y los archivos
 * quedan retenidos mientras dure la investigación.
 */
export function Report({ tripId }: { tripId: string }) {
  const { api } = useSession();
  const nav = useNav();
  const [category, setCategory] = useState<Category>('mistreatment');
  const [description, setDescription] = useState('');
  const [media, setMedia] = useState<ChatMessage[]>([]);
  const [evidence, setEvidence] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  useEffect(() => void api.chatHistory(tripId).then((h) => setMedia(h.filter((m) => m.mediaId))).catch(() => {}), [tripId]);
  const toggle = (id: string) => setEvidence((e) => (e.includes(id) ? e.filter((x) => x !== id) : [...e, id].slice(0, 10)));

  if (done)
    return (
      <Screen title="Reporte enviado">
        <Card>
          <P>{done}</P>
          <P muted>Te contactaremos por la app o por SMS. Puedes ver el estado en Cuenta → Mis reportes.</P>
        </Card>
        <Button label="Volver" onPress={nav.back} />
      </Screen>
    );
  return (
    <Screen title="Reportar al conductor">
      <P muted>Si estás en peligro ahora, usa el botón SOS. Este formulario es para revisar lo ocurrido con calma.</P>
      <Card>
        <P style={{ fontWeight: '700' }}>¿Qué pasó?</P>
        <Choice<Category> value={category} onChange={setCategory} options={[...CATEGORIES]} />
        {category === 'discrimination' || category === 'harassment' ? <P muted>Los casos de discriminación (incluida la orientación sexual o identidad de género) y acoso se atienden con prioridad alta.</P> : null}
        <Field label="Cuéntanos con detalle (mín. 20 caracteres)" value={description} onChangeText={setDescription} multiline maxLength={2000} style={{ minHeight: 110, textAlignVertical: 'top', color: C.ink, backgroundColor: C.card2, borderWidth: 1, borderColor: C.line, borderRadius: 14, padding: 12 }} />
      </Card>
      {media.length ? (
        <Card>
          <P style={{ fontWeight: '700' }}>Pruebas del chat (opcional)</P>
          <P muted>Marca las notas de voz, fotos o videos que muestran lo ocurrido. El chat de texto se adjunta automáticamente.</P>
          {media.map((m) => (
            <Pressable key={m.mediaId} onPress={() => toggle(m.mediaId!)} accessibilityRole="checkbox" accessibilityState={{ checked: evidence.includes(m.mediaId!) }}>
              <Text style={{ color: evidence.includes(m.mediaId!) ? C.brand2 : C.ink, paddingVertical: 6 }}>
                {evidence.includes(m.mediaId!) ? '☑' : '☐'} {KIND_LABEL[m.kind!]} · {m.from === 'driver' ? 'del conductor' : 'tuya'} · {new Date(m.at).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })}
              </Text>
            </Pressable>
          ))}
        </Card>
      ) : null}
      <P muted>Los reportes falsos o malintencionados también se sancionan. El conductor no verá tus datos de contacto.</P>
      <ErrorText error={error} />
      <Button label="Enviar reporte" kind="danger" loading={busy} disabled={description.trim().length < 20} onPress={() => run(async () => setDone((await api.report(tripId, category, description.trim(), evidence)).message))} />
    </Screen>
  );
}

const STATUS_LABEL: Record<string, string> = { open: 'Recibido', investigating: 'En investigación', resolved: 'Resuelto', dismissed: 'Cerrado sin sanción' };
const CAT_LABEL: Record<string, string> = Object.fromEntries(CATEGORIES.map((c) => [c.value, c.label]));

export function MyReports() {
  const { api } = useSession();
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.myReports>> | null>(null);
  const { error, run } = useAction();
  useEffect(() => void run(async () => setRows(await api.myReports())), []);
  return (
    <Screen title="Mis reportes">
      {rows?.length === 0 ? <P muted>No has enviado reportes.</P> : null}
      {rows?.map((r) => (
        <Card key={r.id}>
          <P style={{ fontWeight: '700' }}>{CAT_LABEL[r.category] ?? r.category}</P>
          <P muted>
            {STATUS_LABEL[r.status] ?? r.status} · {new Date(r.createdAt).toLocaleDateString('es-EC')}
          </P>
        </Card>
      ))}
      <ErrorText error={error} />
    </Screen>
  );
}
