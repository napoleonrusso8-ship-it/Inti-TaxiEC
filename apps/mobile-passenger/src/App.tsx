import { useContext, useEffect, useState } from 'react';
import { BackHandler } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavProvider, useNav } from './lib/nav';
import { startSession, type AppSession } from './lib/session';
import { SessionContext } from './lib/session-context';
import { Booking } from './screens/Booking';
import { History } from './screens/History';
import { Home } from './screens/Home';
import { Login } from './screens/Login';
import { RouteDetail } from './screens/RouteDetail';
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
    case 'route':
      return <RouteDetail routeId={p.routeId} />;
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
      <StatusBar style="dark" />
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
