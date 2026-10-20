import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { errorMessage } from '@intitaxi/mobile-core';
import { useNav } from '../lib/nav';

/** Paleta "Inti": negro profundo y dorado, tipografía con serifa en títulos. */
export const C = {
  bg: '#0B0B0D',
  card: '#16161A',
  card2: '#1E1E24',
  ink: '#F4F1EA',
  muted: '#9A978F',
  line: '#2A2A31',
  brand: '#D4A84B',
  brand2: '#F1D38A',
  brandInk: '#1A1405',
  accent: '#D4A84B',
  ok: '#5FBF8F',
  danger: '#E5484D',
};
export const SERIF = 'serif';

export function Screen({ title, children, scroll = true, right }: { title?: string; children: ReactNode; scroll?: boolean; right?: ReactNode }) {
  const nav = useNav();
  const body = <View style={s.body}>{children}</View>;
  return (
    <SafeAreaView style={s.screen} edges={['top', 'left', 'right']}>
      {title ? (
        <View style={s.header}>
          {nav.canGoBack ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Volver" onPress={nav.back} hitSlop={12}>
              <Text style={s.back}>‹</Text>
            </Pressable>
          ) : null}
          <Text style={s.title} numberOfLines={1}>
            {title}
          </Text>
          {right}
        </View>
      ) : null}
      {scroll ? <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">{body}</ScrollView> : body}
    </SafeAreaView>
  );
}

export function H({ children }: { children: ReactNode }) {
  return <Text style={s.h}>{children}</Text>;
}

export function P({ children, muted, center, style }: { children: ReactNode; muted?: boolean; center?: boolean; style?: object }) {
  return <Text style={[s.p, muted && s.muted, center && { textAlign: 'center' }, style]}>{children}</Text>;
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Button({ label, onPress, kind = 'primary', disabled, loading }: { label: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger' | 'brand'; disabled?: boolean; loading?: boolean }) {
  const bg = { primary: C.brand, secondary: 'transparent', danger: C.danger, brand: C.brand }[kind];
  const fg = kind === 'secondary' ? C.ink : kind === 'danger' ? '#fff' : C.brandInk;
  return (
    <Pressable accessibilityRole="button" disabled={disabled || loading} onPress={onPress} style={({ pressed }) => [s.btn, { backgroundColor: bg, borderWidth: kind === 'secondary' ? 1 : 0, borderColor: C.line, opacity: disabled ? 0.45 : pressed ? 0.85 : 1 }]}>
      {loading ? <ActivityIndicator color={fg} /> : <Text style={[s.btnText, { color: fg }]}>{label}</Text>}
    </Pressable>
  );
}

export function Field({ label, ...props }: { label: string } & TextInputProps) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput placeholderTextColor="#9CA3AF" style={s.input} {...props} />
    </View>
  );
}

/** Selector de opciones en fila (segmentado). */
export function Choice<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <View style={s.choice}>
      {options.map((o) => (
        <Pressable key={o.value} accessibilityRole="radio" accessibilityState={{ selected: o.value === value }} onPress={() => onChange(o.value)} style={[s.choiceItem, o.value === value && s.choiceOn]}>
          <Text style={[s.choiceText, o.value === value && { color: C.brand2 }]}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 10 }, style]}>{children}</View>;
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? <Text style={s.error}>{error}</Text> : null;
}

export function Loading({ label }: { label?: string }) {
  return (
    <View style={{ padding: 32, alignItems: 'center', gap: 12 }}>
      <ActivityIndicator color={C.brand} size="large" />
      {label ? <P muted>{label}</P> : null}
    </View>
  );
}

/** Ejecuta acciones asíncronas mostrando "cargando" y el error del servidor en español. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errorMessage(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.line, backgroundColor: C.bg },
  back: { fontSize: 32, lineHeight: 32, color: C.brand, paddingRight: 4 },
  title: { flex: 1, fontSize: 20, color: C.ink, fontFamily: SERIF },
  scroll: { paddingBottom: 40 },
  body: { padding: 16, gap: 14, flexGrow: 1 },
  h: { fontSize: 26, color: C.ink, fontFamily: SERIF, letterSpacing: 0.3 },
  p: { fontSize: 15, color: C.ink, lineHeight: 21 },
  muted: { color: C.muted, fontSize: 13 },
  card: { backgroundColor: C.card, borderRadius: 18, borderWidth: 1, borderColor: C.line, padding: 16, gap: 10 },
  btn: { borderRadius: 14, paddingVertical: 15, paddingHorizontal: 18, alignItems: 'center', minHeight: 50, justifyContent: 'center' },
  btnText: { fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
  label: { fontSize: 12, color: C.muted, letterSpacing: 0.4, textTransform: 'uppercase' },
  input: { borderWidth: 1, borderColor: C.line, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 13, fontSize: 16, backgroundColor: C.card2, color: C.ink },
  choice: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choiceItem: { borderWidth: 1, borderColor: C.line, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: C.card2 },
  choiceOn: { backgroundColor: 'rgba(212,168,75,0.16)', borderColor: C.brand },
  choiceText: { color: C.ink, fontSize: 14 },
  error: { color: C.danger, fontWeight: '600' },
});

/** Insignia pequeña dorada (identidad verificada, aliado, conductora…). */
export function Badge({ children }: { children: ReactNode }) {
  return (
    <View style={{ backgroundColor: 'rgba(212,168,75,0.15)', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' }}>
      <Text style={{ color: C.brand2, fontSize: 11, fontWeight: '600' }}>{children}</Text>
    </View>
  );
}

/** Etiqueta de reconocimiento con su conteo (Amable 312). */
export function Tag({ label, count }: { label: string; count?: number }) {
  return (
    <View style={{ borderWidth: 1, borderColor: C.line, borderRadius: 16, paddingHorizontal: 10, paddingVertical: 5 }}>
      <Text style={{ color: '#D8D3C6', fontSize: 12 }}>
        {label}
        {count !== undefined ? ` ${count}` : ''}
      </Text>
    </View>
  );
}

export function Stars({ value }: { value: number | null }) {
  const n = Math.round(value ?? 0);
  return <Text style={{ color: C.brand, fontSize: 13 }}>{'★'.repeat(n)}{'☆'.repeat(5 - n)}</Text>;
}

/** Selector de monto con − / + (ofertas de grúa y alquiler). */
export function Stepper({ valueCents, onChange, stepCents = 100, minCents, maxCents }: { valueCents: number; onChange: (v: number) => void; stepCents?: number; minCents: number; maxCents: number }) {
  const btn = (label: string, delta: number) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label === '−' ? 'Bajar' : 'Subir'} onPress={() => onChange(Math.min(maxCents, Math.max(minCents, valueCents + delta)))} style={{ width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: C.ink, fontSize: 22 }}>{label}</Text>
    </Pressable>
  );
  return (
    <Row style={{ justifyContent: 'center', gap: 22 }}>
      {btn('−', -stepCents)}
      <Text style={{ color: C.ink, fontSize: 40, fontWeight: '300' }}>${(valueCents / 100).toFixed(valueCents % 100 ? 2 : 0)}</Text>
      {btn('+', stepCents)}
    </Row>
  );
}
