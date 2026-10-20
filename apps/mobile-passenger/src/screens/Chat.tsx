import { useEffect, useRef, useState } from 'react';
import { Alert, FlatList, Image, Pressable, Text, TextInput, View } from 'react-native';
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import * as ImagePicker from 'expo-image-picker';
import { useVideoPlayer, VideoView } from 'expo-video';
import type { ChatMessage, UploadInstructions } from '@intitaxi/mobile-core';
import { useSession } from '../lib/session-context';
import { C, ErrorText, Row, Screen, useAction } from '../ui/kit';

const MAX_VIDEO_S = 20;
const MAX_VOICE_S = 60;
type Kind = 'voice' | 'photo' | 'video';

/**
 * Chat del viaje: texto por tiempo real; notas de voz, fotos y videos (≤ 20 s) por la API.
 * El servidor revisa cada archivo (tipo real, duración, metadatos de ubicación) antes de entregarlo,
 * y lo borra a los 30 días salvo que haya un reporte o SOS.
 */
export function Chat({ tripId, start }: { tripId: string; start?: Kind }) {
  const { api, realtime } = useSession();
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState<string | null>(null);
  const { error, setError, run } = useAction();
  const list = useRef<FlatList<ChatMessage>>(null);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const rec = useAudioRecorderState(recorder, 250);

  const add = (m: ChatMessage) => setMsgs((prev) => (prev.some((x) => x.at === m.at && x.from === m.from && x.mediaId === m.mediaId && x.text === m.text) ? prev : [...prev, m].sort((a, b) => a.at.localeCompare(b.at))));

  useEffect(() => {
    void run(async () => (await api.chatHistory(tripId)).forEach(add));
    realtime.connect();
    realtime.subscribe(`trip:${tripId}`);
    const off = realtime.on((m) => m.type === 'chat' && add(m as ChatMessage));
    if (start === 'voice') void toggleVoice();
    else if (start) void pick(start, 'camera');
    return () => (off(), realtime.unsubscribe(`trip:${tripId}`));
  }, [tripId]);
  // La grabación se corta sola a los 60 s.
  useEffect(() => {
    if (rec.isRecording && rec.durationMillis >= MAX_VOICE_S * 1000) void toggleVoice();
  }, [rec.durationMillis]);

  const sendText = () => {
    const t = text.trim();
    if (!t) return;
    realtime.chat(tripId, t);
    setText('');
  };

  const upload = (kind: Kind, uri: string, contentType: string) =>
    run(async () => {
      setSending(kind === 'voice' ? 'Enviando nota de voz…' : kind === 'photo' ? 'Enviando foto…' : 'Enviando video…');
      try {
        const blob = await (await fetch(uri)).blob();
        const { mediaId, upload } = await api.chatUploadUrl(tripId, kind, contentType, blob.size);
        await sendFile(upload, uri, blob, contentType);
        add(await api.chatComplete(tripId, mediaId));
      } finally {
        setSending(null);
      }
    });

  async function toggleVoice() {
    if (rec.isRecording || recorder.isRecording) {
      await recorder.stop();
      if (recorder.uri) await upload('voice', recorder.uri, 'audio/mp4');
      return;
    }
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) return setError('Permite el micrófono para enviar notas de voz');
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record({ forDuration: MAX_VOICE_S });
  }

  async function pick(kind: 'photo' | 'video', source: 'camera' | 'library') {
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: [kind === 'photo' ? 'images' : 'videos'], quality: 0.7, videoMaxDuration: MAX_VIDEO_S, exif: false, allowsEditing: false };
    if (source === 'camera' && !(await ImagePicker.requestCameraPermissionsAsync()).granted) return setError('Permite la cámara para enviar fotos o videos');
    const r = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    const a = r.canceled ? null : r.assets[0];
    if (!a) return;
    if (kind === 'video' && (a.duration ?? 0) > MAX_VIDEO_S * 1000 + 500) return setError(`El video debe durar ${MAX_VIDEO_S} segundos o menos`);
    const type = kind === 'video' ? 'video/mp4' : a.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
    await upload(kind, a.uri, type);
  }

  const chooseSource = (kind: 'photo' | 'video') =>
    Alert.alert(kind === 'photo' ? 'Enviar foto' : `Enviar video (máx. ${MAX_VIDEO_S} s)`, undefined, [
      { text: 'Cámara', onPress: () => void pick(kind, 'camera') },
      { text: 'Galería', onPress: () => void pick(kind, 'library') },
      { text: 'Cancelar', style: 'cancel' },
    ]);

  return (
    <Screen title="Chat con el conductor" scroll={false}>
      <FlatList
        ref={list}
        style={{ flex: 1 }}
        data={msgs}
        keyExtractor={(m, i) => `${m.at}-${i}`}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
        contentContainerStyle={{ gap: 8, paddingVertical: 8 }}
        ListHeaderComponent={<Text style={{ color: C.muted, fontSize: 12, textAlign: 'center' }}>No compartas datos personales ni de pago. Los mensajes se guardan 30 días por seguridad.</Text>}
        renderItem={({ item }) => <Bubble tripId={tripId} m={item} />}
      />
      {sending ? <Text style={{ color: C.brand2 }}>{sending}</Text> : null}
      {rec.isRecording ? (
        <Text style={{ color: C.danger, fontWeight: '600' }}>
          ● Grabando {Math.floor(rec.durationMillis / 1000)} s / {MAX_VOICE_S} s — toca 🎤 para enviar
        </Text>
      ) : null}
      <ErrorText error={error} />
      <Row style={{ gap: 8 }}>
        <IconBtn label="🎤" a11y={rec.isRecording ? 'Detener y enviar nota de voz' : 'Grabar nota de voz'} on={() => void toggleVoice()} active={rec.isRecording} />
        <IconBtn label="📷" a11y="Enviar foto" on={() => chooseSource('photo')} />
        <IconBtn label="🎬" a11y="Enviar video" on={() => chooseSource('video')} />
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Escribe un mensaje"
          placeholderTextColor={C.muted}
          maxLength={500}
          onSubmitEditing={sendText}
          returnKeyType="send"
          style={{ flex: 1, color: C.ink, backgroundColor: C.card2, borderWidth: 1, borderColor: C.line, borderRadius: 22, paddingHorizontal: 14, paddingVertical: 10 }}
        />
        <IconBtn label="➤" a11y="Enviar" on={sendText} active />
      </Row>
    </Screen>
  );
}

/** Sube el archivo según lo que indique el servidor (URL firmada PUT o formulario POST). */
async function sendFile(u: UploadInstructions, uri: string, blob: Blob, contentType: string) {
  let r: Response;
  if (u.method === 'PUT') {
    r = await fetch(u.url, { method: 'PUT', headers: { 'content-type': contentType, ...u.headers }, body: blob });
  } else {
    const form = new FormData();
    for (const [k, v] of Object.entries(u.fields ?? {})) form.append(k, v);
    form.append('file', { uri, type: contentType, name: 'archivo' } as unknown as Blob);
    r = await fetch(u.url, { method: 'POST', headers: u.headers, body: form });
  }
  if (!r.ok) throw new Error('No se pudo subir el archivo. Revisa tu conexión e intenta de nuevo.');
}

function IconBtn({ label, a11y, on, active }: { label: string; a11y: string; on: () => void; active?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={a11y} onPress={on} style={{ width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? C.brand : C.card2, borderWidth: 1, borderColor: active ? C.brand : C.line }}>
      <Text style={{ fontSize: 17, color: active ? C.brandInk : C.ink }}>{label}</Text>
    </Pressable>
  );
}

function Bubble({ tripId, m }: { tripId: string; m: ChatMessage }) {
  const mine = m.from === 'passenger';
  return (
    <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '82%', backgroundColor: mine ? 'rgba(212,168,75,0.18)' : C.card2, borderColor: mine ? C.brand : C.line, borderWidth: 1, borderRadius: 16, padding: 10, gap: 4 }}>
      {m.text ? <Text style={{ color: C.ink, fontSize: 15 }}>{m.text}</Text> : null}
      {m.mediaId && m.kind ? <Media tripId={tripId} mediaId={m.mediaId} kind={m.kind} durationMs={m.durationMs ?? null} /> : null}
      <Text style={{ color: C.muted, fontSize: 10, alignSelf: 'flex-end' }}>{new Date(m.at).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })}</Text>
    </View>
  );
}

/** Los archivos se piden al tocarlos: la URL de descarga dura 60 s y no se guarda en el teléfono. */
function Media({ tripId, mediaId, kind, durationMs }: { tripId: string; mediaId: string; kind: Kind; durationMs: number | null }) {
  const { api } = useSession();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const open = () => api.chatMediaUrl(tripId, mediaId).then((r) => setUrl(r.url), () => setFailed(true));
  const secs = durationMs ? `${Math.round(durationMs / 1000)} s` : '';
  if (failed) return <Text style={{ color: C.muted }}>Archivo no disponible</Text>;
  if (!url)
    return (
      <Pressable onPress={() => void open()} accessibilityRole="button">
        <Text style={{ color: C.brand2 }}>{kind === 'voice' ? `▶ Nota de voz ${secs}` : kind === 'photo' ? '🖼 Ver foto' : `▶ Video ${secs}`}</Text>
      </Pressable>
    );
  if (kind === 'photo') return <Image source={{ uri: url }} style={{ width: 220, height: 220, borderRadius: 10 }} resizeMode="cover" />;
  if (kind === 'video') return <Video url={url} />;
  return <Voice url={url} />;
}

function Voice({ url }: { url: string }) {
  const player = useAudioPlayer(url);
  const st = useAudioPlayerStatus(player);
  useEffect(() => void player.play(), [player]);
  return (
    <Pressable onPress={() => (st.playing ? player.pause() : (st.didJustFinish && player.seekTo(0), player.play()))} accessibilityRole="button">
      <Text style={{ color: C.brand2 }}>
        {st.playing ? '❚❚' : '▶'} {Math.round(st.currentTime)} / {Math.round(st.duration || 0)} s
      </Text>
    </Pressable>
  );
}

function Video({ url }: { url: string }) {
  const player = useVideoPlayer(url, (p) => p.play());
  return <VideoView player={player} style={{ width: 220, height: 300, borderRadius: 10 }} nativeControls contentFit="contain" />;
}

