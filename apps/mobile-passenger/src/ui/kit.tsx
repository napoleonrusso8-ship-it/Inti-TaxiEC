import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { errorMessage } from '@intitaxi/mobile-core';
import { useNav } from '../lib/nav';

export const C = {
  bg: '#F6F5F2',
  card: '#FFFFFF',
  ink: '#1D232A',
  muted: '#6B7280',
  line: '#E3E1DC',
  brand: '#F2A900',
  brandInk: '#3A2A00',
  accent: '#1F4E79',
  ok: '#13795B',
  danger: '#B42318',
};

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
  const bg = { primary: C.accent, secondary: '#E8EEF4', danger: C.danger, brand: C.brand }[kind];
  const fg = kind === 'secondary' ? C.accent : kind === 'brand' ? C.brandInk : '#fff';
  return (
    <Pressable accessibilityRole="button" disabled={disabled || loading} onPress={onPress} style={({ pressed }) => [s.btn, { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 }]}>
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
          <Text style={[s.choiceText, o.value === value && { color: '#fff' }]}>{o.label}</Text>
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
      <ActivityIndicator color={C.accent} size="large" />
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
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line, backgroundColor: C.card },
  back: { fontSize: 32, lineHeight: 32, color: C.accent, paddingRight: 4 },
  title: { flex: 1, fontSize: 18, fontWeight: '700', color: C.ink },
  scroll: { paddingBottom: 40 },
  body: { padding: 16, gap: 14, flexGrow: 1 },
  h: { fontSize: 22, fontWeight: '700', color: C.ink },
  p: { fontSize: 15, color: C.ink, lineHeight: 21 },
  muted: { color: C.muted, fontSize: 13 },
  card: { backgroundColor: C.card, borderRadius: 12, borderWidth: 1, borderColor: C.line, padding: 14, gap: 10 },
  btn: { borderRadius: 10, paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center', minHeight: 48, justifyContent: 'center' },
  btnText: { fontSize: 16, fontWeight: '600' },
  label: { fontSize: 13, color: C.muted },
  input: { borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, fontSize: 16, backgroundColor: '#fff', color: C.ink },
  choice: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choiceItem: { borderWidth: 1, borderColor: C.line, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: '#fff' },
  choiceOn: { backgroundColor: C.accent, borderColor: C.accent },
  choiceText: { color: C.ink, fontSize: 14 },
  error: { color: C.danger, fontWeight: '600' },
});
