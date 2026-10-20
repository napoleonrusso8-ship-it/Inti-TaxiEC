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
    case 'trip':
      return <Trip tripId={p.tripId} />;
    case 'sos':
      return <Sos incidentId={p.incidentId} />;
    case 'request':
      return <RequestTrip womenOnly={p.womenOnly} />;
    case 'chat':
      return <Chat tripId={p.tripId} start={p.start} />;
    case 'report':
      return <Report tripId={p.tripId} />;
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
  const [error, setError] = useState<string | null>(null);
  const boot = () => {
    setError(null);
    startSession().then(setSession, (e) => setError(errorMessage(e)));
  };
  useEffect(boot, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {session ? (
        <SessionContext.Provider value={session}>
          <NavProvider initial={{ name: session.client.loggedIn ? 'home' : 'login' }}>
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
