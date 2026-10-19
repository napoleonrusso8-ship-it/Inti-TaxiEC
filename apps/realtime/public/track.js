// Página pública de seguimiento: solo lectura; el token del enlace autoriza UN viaje.
(function () {
  var token = location.pathname.split('/').pop();
  var STATUS = {
    matching: 'Buscando conductor', accepted: 'El taxi va en camino', arrived: 'El taxi llegó', in_progress: 'En viaje',
    completed: 'Viaje terminado', cancelled: 'Viaje cancelado', no_drivers: 'Sin conductores disponibles',
  };
  var map = L.map('map').setView([-2.17, -79.9], 13);
  L.tileLayer(document.body.dataset.tiles, { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  var marker = null;
  var statusEl = document.getElementById('status');

  function setStatus(s) { statusEl.textContent = STATUS[s] || s; }
  function setDriver(d) {
    if (!d) return;
    document.getElementById('card').hidden = false;
    document.getElementById('driver').textContent = d.firstName || '';
    document.getElementById('vehicle').textContent = d.vehicle ? [d.vehicle.make, d.vehicle.model, d.vehicle.color].join(' ') : '';
    document.getElementById('plate').textContent = d.vehicle ? d.vehicle.plate : '';
  }
  function setLocation(lat, lng) {
    if (!marker) { marker = L.circleMarker([lat, lng], { radius: 9, weight: 3 }).addTo(map); map.setView([lat, lng], 15); }
    else marker.setLatLng([lat, lng]);
  }

  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var ws = new WebSocket(proto + '//' + location.host + '/v1/ws?share=' + encodeURIComponent(token));
  ws.onmessage = function (ev) {
    var m = JSON.parse(ev.data);
    if (m.type === 'subscribed' && m.snapshot) {
      if (m.snapshot.status) setStatus(m.snapshot.status);
      setDriver(m.snapshot.driver);
      if (m.snapshot.location) setLocation(m.snapshot.location.lat, m.snapshot.location.lng);
    }
    if (m.type === 'status') setStatus(m.status);
    if (m.type === 'driver') setDriver(m.driver);
    if (m.type === 'location') setLocation(m.lat, m.lng);
  };
  ws.onclose = function () { if (statusEl.textContent === 'Conectando…') statusEl.textContent = 'Enlace vencido'; };
})();
