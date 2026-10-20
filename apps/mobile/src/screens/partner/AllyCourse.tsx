import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { usePartner } from '../../lib/session-context';
import { Button, C, Card, Choice, ErrorText, Loading, P, PrideBar, Screen, Section, SERIF, useAction } from '../../ui/kit';

type Course = Awaited<ReturnType<ReturnType<typeof usePartner>['api']['allyCourse']>>;

/** Curso "Conductor Aliado": respeto e inclusión de la comunidad LGBTI. Al aprobarlo se obtiene la insignia. */
export function AllyCourse() {
  const { api } = usePartner();
  const [course, setCourse] = useState<Course | null>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [passed, setPassed] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => void run(async () => setCourse(await api.allyCourse())), []);
  if (!course) return <Screen title="Conductor Aliado">{error ? <ErrorText error={error} /> : <Loading />}</Screen>;
  if (passed)
    return (
      <Screen title="Conductor Aliado">
        <PrideBar height={6} />
        <Text style={{ color: C.ink, fontFamily: SERIF, fontSize: 26 }}>¡Felicitaciones! 🤝</Text>
        <P>Ya tienes la insignia Aliado. Los pasajeros que piden "solo Conductores Aliados" ahora pueden viajar contigo.</P>
      </Screen>
    );
  return (
    <Screen title="Conductor Aliado" subtitle="5 minutos · 3 preguntas">
      <PrideBar />
      <Section>Lo esencial</Section>
      <Card>
        {course.lessons.map((l, i) => (
          <P key={i}>
            {i + 1}. {l}
          </P>
        ))}
      </Card>
      <Section>Evaluación</Section>
      {course.questions.map((q) => (
        <Card key={q.id}>
          <P style={{ fontWeight: '700' }}>{q.text}</P>
          <Choice value={String(answers[q.id] ?? '')} onChange={(v) => setAnswers({ ...answers, [q.id]: Number(v) })} options={q.options.map((o, i) => ({ value: String(i), label: o }))} />
        </Card>
      ))}
      <ErrorText error={error} />
      <Button label="Enviar respuestas" loading={busy} disabled={Object.keys(answers).length < course.questions.length} onPress={() => run(async () => (await api.certifyAlly(answers), setPassed(true)))} />
    </Screen>
  );
}
