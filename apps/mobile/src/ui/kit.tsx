import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { errorMessage } from '@intitaxi/mobile-core';
import { useNav } from '../lib/nav';

/**
 * Sistema de diseño "Inti": negro profundo, dorado cálido y títulos con serifa.
 * Espacios amplios, bordes finos y un solo color de acento por pantalla.
 */
export const C = {
  bg: '#09090B',
  card: '#141418',
  card2: '#1C1C22',
  raised: '#24242C',
  ink: '#F5F2EA',
  muted: '#9C988E',
  faint: '#5E5B55',
  line: '#26262E',
  brand: '#D9AE52',
  brand2: '#F3D58E',
  brandInk: '#1A1405',
  brandSoft: 'rgba(217,174,82,0.14)',
  accent: '#D9AE52',
  ok: '#5FBF8F',
  okSoft: 'rgba(95,191,143,0.14)',
  danger: '#E5484D',
  dangerSoft: 'rgba(229,72,77,0.12)',
};
/** Colores del arcoíris para la identidad de Modo Ellxs. */
export const PRIDE = ['#E40303', '#FF8C00', '#FFED00', '#008026', '#24408E', '#732982'];
export const SERIF = 'serif';

export function Screen({ title, subtitle, children, scroll = true, right }: { title?: string; subtitle?: string; children: ReactNode; scroll?: boolean; right?: ReactNode }) {
  const nav = useNav();
  const body = <View style={[s.body, !scroll && { flex: 1 }]}>{children}</View>;
  return (
    <SafeAreaView style={s.screen} edges={['top', 'left', 'right']}>
      {title ? (
        <View style={s.header}>
          {nav.canGoBack ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Volver" onPress={nav.back} hitSlop={12} style={s.backBtn}>
              <Text style={s.back}>‹</Text>
            </Pressable>
          ) : null}
          <View style={{ flex: 1 }}>
            <Text style={s.title} numberOfLines={1}>
              {title}
            </Text>
            {subtitle ? <Text style={s.subtitle}>{subtitle}</Text> : null}
          </View>
          {right}
        </View>
      ) : null}
      {scroll ? <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">{body}</ScrollView> : body}
    </SafeAreaView>
  );
}

export function H({ children, size = 26 }: { children: ReactNode; size?: number }) {
  return <Text style={[s.h, { fontSize: size }]}>{children}</Text>;
}

/** Rótulo pequeño en mayúsculas para separar secciones. */
export function Section({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6 }}>
      <Text style={[s.label, { flex: 1 }]}>{children}</Text>
      {right}
    </View>
  );
}

export function P({ children, muted, center, style }: { children: ReactNode; muted?: boolean; center?: boolean; style?: object }) {
  return <Text style={[s.p, muted && s.muted, center && { textAlign: 'center' }, style]}>{children}</Text>;
}

export function Card({ children, style, onPress }: { children: ReactNode; style?: ViewStyle; onPress?: () => void }) {
  if (!onPress) return <View style={[s.card, style]}>{children}</View>;
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [s.card, style, pressed && { borderColor: C.brand }]}>
      {children}
    </Pressable>
  );
}

export function Button({ label, onPress, kind = 'primary', disabled, loading, small }: { label: string; onPress: () => void; kind?: 'primary' | 'secondary' | 'danger' | 'brand' | 'ghost'; disabled?: boolean; loading?: boolean; small?: boolean }) {
  const bg = { primary: C.brand, brand: C.brand, secondary: 'transparent', danger: C.danger, ghost: 'transparent' }[kind];
  const fg = kind === 'secondary' || kind === 'ghost' ? (kind === 'ghost' ? C.brand2 : C.ink) : kind === 'danger' ? '#fff' : C.brandInk;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [s.btn, small && { minHeight: 40, paddingVertical: 9 }, { backgroundColor: bg, borderWidth: kind === 'secondary' ? 1 : 0, borderColor: C.line, opacity: disabled ? 0.4 : pressed ? 0.85 : 1 }]}
    >
      {loading ? <ActivityIndicator color={fg} /> : <Text style={[s.btnText, { color: fg }, small && { fontSize: 14 }]}>{label}</Text>}
    </Pressable>
  );
}

export function Field({ label, hint, ...props }: { label: string; hint?: string } & TextInputProps) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput placeholderTextColor={C.faint} style={[s.input, props.multiline && { minHeight: 96, textAlignVertical: 'top' }]} {...props} />
      {hint ? <Text style={[s.muted, { fontSize: 12 }]}>{hint}</Text> : null}
    </View>
  );
}

/** Selector de opciones en fila (chips). */
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

/** Control segmentado de ancho completo (p. ej. Viajar | Trabajar). */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <View style={{ flexDirection: 'row', backgroundColor: C.card2, borderRadius: 16, padding: 4, borderWidth: 1, borderColor: C.line }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => onChange(o.value)} style={{ flex: 1, paddingVertical: 10, borderRadius: 12, alignItems: 'center', backgroundColor: on ? C.brand : 'transparent' }}>
            <Text style={{ color: on ? C.brandInk : C.muted, fontWeight: '700', letterSpacing: 0.3 }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 10 }, style]}>{children}</View>;
}

/** Fila de lista: ícono, título, detalle y flecha. */
export function ListItem({ icon, title, subtitle, onPress, right, danger }: { icon?: string; title: string; subtitle?: string; onPress?: () => void; right?: ReactNode; danger?: boolean }) {
  return (
    <Pressable accessibilityRole={onPress ? 'button' : undefined} disabled={!onPress} onPress={onPress} style={({ pressed }) => [s.item, pressed && { backgroundColor: C.card2 }]}>
      {icon ? <IconCircle icon={icon} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: danger ? C.danger : C.ink, fontSize: 16, fontWeight: '600' }}>{title}</Text>
        {subtitle ? <Text style={s.muted}>{subtitle}</Text> : null}
      </View>
      {right ?? (onPress ? <Text style={{ color: C.faint, fontSize: 22 }}>›</Text> : null)}
    </Pressable>
  );
}

export function IconCircle({ icon, size = 42, tint }: { icon: string; size?: number; tint?: string }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: tint ?? C.brandSoft, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontSize: size * 0.45 }}>{icon}</Text>
    </View>
  );
}

/** Indicador de estado (aprobado, en revisión, pendiente…). */
export function Pill({ children, tone = 'brand' }: { children: ReactNode; tone?: 'brand' | 'ok' | 'danger' | 'muted' }) {
  const bg = { brand: C.brandSoft, ok: C.okSoft, danger: C.dangerSoft, muted: C.card2 }[tone];
  const fg = { brand: C.brand2, ok: C.ok, danger: C.danger, muted: C.muted }[tone];
  return (
    <View style={{ backgroundColor: bg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'flex-start' }}>
      <Text style={{ color: fg, fontSize: 12, fontWeight: '700' }}>{children}</Text>
    </View>
  );
}

/** Cifra destacada (ganancias, puntos, asientos). */
export function Stat({ label, value, tone }: { label: string; value: string; tone?: 'brand' | 'ok' }) {
  return (
    <View style={{ flex: 1, backgroundColor: C.card, borderRadius: 18, borderWidth: 1, borderColor: C.line, padding: 14, gap: 4 }}>
      <Text style={s.label}>{label}</Text>
      <Text style={{ color: tone === 'ok' ? C.ok : C.brand2, fontFamily: SERIF, fontSize: 26 }}>{value}</Text>
    </View>
  );
}

/** Franja arcoíris discreta (identidad de Modo Ellxs). */
export function PrideBar({ height = 4 }: { height?: number }) {
  return (
    <View style={{ flexDirection: 'row', height, borderRadius: height, overflow: 'hidden' }}>
      {PRIDE.map((c) => (
        <View key={c} style={{ flex: 1, backgroundColor: c }} />
      ))}
    </View>
  );
}

export function Empty({ icon, title, text }: { icon: string; title: string; text?: string }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: 28, gap: 8 }}>
      <Text style={{ fontSize: 34 }}>{icon}</Text>
      <Text style={{ color: C.ink, fontFamily: SERIF, fontSize: 18 }}>{title}</Text>
      {text ? <P muted center>{text}</P> : null}
    </View>
  );
}

/** Barra de pestañas inferior. */
export function TabBar<T extends string>({ tabs, value, onChange }: { tabs: { id: T; icon: string; label: string }[]; value: T; onChange: (t: T) => void }) {
  return (
    <SafeAreaView edges={['bottom']} style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: C.line, backgroundColor: C.bg }}>
      {tabs.map((t) => {
        const on = t.id === value;
        return (
          <Pressable key={t.id} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => onChange(t.id)} style={{ flex: 1, paddingTop: 10, paddingBottom: 8, alignItems: 'center', gap: 2 }}>
            <Text style={{ fontSize: 18, opacity: on ? 1 : 0.55 }}>{t.icon}</Text>
            <Text style={{ color: on ? C.brand : C.muted, fontSize: 11, fontWeight: on ? '700' : '500' }}>{t.label}</Text>
          </Pressable>
        );
      })}
    </SafeAreaView>
  );
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
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 12, backgroundColor: C.bg },
  backBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.card2, alignItems: 'center', justifyContent: 'center' },
  back: { fontSize: 26, lineHeight: 28, color: C.brand2, marginTop: -2 },
  title: { fontSize: 24, color: C.ink, fontFamily: SERIF, letterSpacing: 0.2 },
  subtitle: { color: C.muted, fontSize: 13, marginTop: 2 },
  scroll: { paddingBottom: 48 },
  body: { paddingHorizontal: 16, paddingTop: 4, gap: 14, flexGrow: 1 },
  h: { color: C.ink, fontFamily: SERIF, letterSpacing: 0.3 },
  p: { fontSize: 15, color: C.ink, lineHeight: 22 },
  muted: { color: C.muted, fontSize: 13, lineHeight: 19 },
  card: { backgroundColor: C.card, borderRadius: 20, borderWidth: 1, borderColor: C.line, padding: 16, gap: 10 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 12, paddingHorizontal: 4, borderRadius: 14 },
  btn: { borderRadius: 16, paddingVertical: 15, paddingHorizontal: 18, alignItems: 'center', minHeight: 52, justifyContent: 'center' },
  btnText: { fontSize: 16, fontWeight: '700', letterSpacing: 0.3 },
  label: { fontSize: 11, color: C.muted, letterSpacing: 1.2, textTransform: 'uppercase', fontWeight: '600' },
  input: { borderWidth: 1, borderColor: C.line, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 13, fontSize: 16, backgroundColor: C.card2, color: C.ink },
  choice: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choiceItem: { borderWidth: 1, borderColor: C.line, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: C.card2 },
  choiceOn: { backgroundColor: C.brandSoft, borderColor: C.brand },
  choiceText: { color: C.ink, fontSize: 14 },
  error: { color: C.danger, fontWeight: '600' },
});

/** Insignia pequeña dorada (identidad verificada, aliado, Ellxs…). */
export function Badge({ children }: { children: ReactNode }) {
  return (
    <View style={{ backgroundColor: C.brandSoft, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start' }}>
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
    <Pressable accessibilityRole="button" accessibilityLabel={label === '−' ? 'Bajar' : 'Subir'} onPress={() => onChange(Math.min(maxCents, Math.max(minCents, valueCents + delta)))} style={{ width: 46, height: 46, borderRadius: 23, borderWidth: 1, borderColor: C.line, backgroundColor: C.card2, alignItems: 'center', justifyContent: 'center' }}>
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
