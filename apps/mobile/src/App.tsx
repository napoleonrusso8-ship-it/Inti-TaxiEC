import { useContext, useEffect, useState } from 'react';
import { BackHandler } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavProvider, useNav } from './lib/nav';
import { startSession, type AppSession } from './lib/session';
import { SessionContext } from './lib/session-context';
import { AssistStatus, Rental, Tow } from './screens/Assist';
import { Booking } from './screens/Booking';
import { Chat } from './screens/Chat';
import { History } from './screens/History';
import { Home } from './screens/Home';
import { Login } from './screens/Login';
import { Points } from './screens/Points';
import { Preferences } from './screens/Preferences';
import { MyReports, Report } from './screens/Report';
import { RequestTrip } from './screens/RequestTrip';
import { RouteDetail } from './screens/RouteDetail';
import { Routes } from './screens/Routes';
import { Safety } from './screens/Safety';
import { Sos } from './screens/Sos';
import { Trip } from './screens/Trip';
import { Verify } from './screens/Verify';
import { AllyCourse } from './screens/partner/AllyCourse';
import { PartnerApply } from './screens/partner/Apply';
import { AssistJob, AssistWork } from './screens/partner/AssistWork';
import { DriverTrip } from './screens/partner/DriverTrip';
import { RoleMenu } from './screens/partner/RoleMenu';
import { RouteWork } from './screens/partner/RouteWork';
import { AddVehicle, UploadDoc } from './screens/partner/Setup';
import { WorkHome } from './screens/partner/WorkHome';
import { errorMessage } from '@intitaxi/mobile-core';
import { Button, ErrorText, H, Loading, P, Screen } from './ui/kit';

function Router() {
  const { route, back, canGoBack, reset } = useNav();
  const session = useSessionOrNull();
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => (canGoBack ? (back(), true) : false));
    return () => sub.remove();
  }, [canGoBack]);
  useEffect(() => {
    if (session) session.client.sessionEnded = () => reset('login');
  }, [session]);
  const p = route.params ?? {};
  switch (route.name) {
    case 'login':
      return <Login />;
    case 'home':
      return <Home />;
    case 'welcome':
      return <RoleMenu />;
    // ----- Modo Trabajar (socios) -----
    case 'work':
      return <WorkHome />;
    case 'partner.join':
      return <RoleMenu onlyPartners />;
    case 'partner.apply':
      return <PartnerApply kind={p.kind} />;
    case 'partner.vehicle':
      return <AddVehicle types={p.types} />;
    case 'partner.doc':
      return <UploadDoc type={p.type} vehicleId={p.vehicleId ?? null} />;
    case 'partner.trip':
      return <DriverTrip tripId={p.tripId} />;
    case 'partner.routes':
      return <RouteWork />;
    case 'partner.assist':
      return <AssistWork kind={p.kind} />;
    case 'partner.assistJob':
      return <AssistJob id={p.id} />;
    case 'partner.ally':
      return <AllyCourse />;
    case 'trip':
      return <Trip tripId={p.tripId} />;
    case 'sos':
      return <Sos incidentId={p.incidentId} />;
    case 'request':
      return <RequestTrip ellxsOnly={p.ellxsOnly} />;
    case 'chat':
      return <Chat tripId={p.tripId} start={p.start} as={p.as} />;
    case 'report':
      return <Report tripId={p.tripId} as={p.as} />;
    case 'reports':
      return <MyReports />;
    case 'routes':
      return <Routes vehicleType={p.vehicleType} />;
    case 'route':
      return <RouteDetail routeId={p.routeId} vehicleType={p.vehicleType} />;
    case 'tow':
      return <Tow />;
    case 'rental':
      return <Rental />;
    case 'assist':
      return <AssistStatus id={p.id} />;
    case 'preferences':
      return <Preferences hint={p.hint} />;
    case 'points':
      return <Points />;
    case 'booking':
      return <Booking bookingId={p.bookingId} tripId={p.tripId} />;
    case 'verify':
      return <Verify />;
    case 'safety':
      return <Safety />;
    case 'history':
      return <History />;
    default:
      return <Home />;
  }
}

const useSessionOrNull = () => useContext(SessionContext);

export default function App() {
  const [session, setSession] = useState<AppSession | null>(null);
  const [start, setStart] = useState<string>('home');
  const [error, setError] = useState<string | null>(null);
  const boot = () => {
    setError(null);
    startSession().then(
      async (sess) => {
        // Abre en el último modo usado (Viajar o Trabajar).
        setStart((await sess.mode.get()) === 'work' ? 'work' : 'home');
        setSession(sess);
      },
      (e) => setError(errorMessage(e)),
    );
  };
  useEffect(boot, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {session ? (
        <SessionContext.Provider value={session}>
          <NavProvider initial={{ name: session.client.loggedIn ? start : 'login' }}>
            <Router />
          </NavProvider>
        </SessionContext.Provider>
      ) : (
        <NavProvider initial={{ name: 'boot' }}>
          <Screen>
            <H>Inti Taxi</H>
            {error ? (
              <>
                <P>No pudimos iniciar la app de forma segura.</P>
                <ErrorText error={error} />
                <Button label="Reintentar" onPress={boot} />
              </>
            ) : (
              <Loading label="Verificando la seguridad del dispositivo…" />
            )}
          </Screen>
        </NavProvider>
      )}
    </SafeAreaProvider>
  );
}
