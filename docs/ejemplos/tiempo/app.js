// Ejemplo de plugin que habla con internet. No puede hacer fetch() él mismo (la página no deja): se lo pide a la aplicación
// con tdt.net.fetch, que solo contesta para los servidores de «network:» en el manifest, por https y a direcciones públicas.
const CIUDADES = {
  Madrid: [40.42, -3.7],
  Barcelona: [41.39, 2.17],
  Sevilla: [37.39, -5.98],
  Bilbao: [43.26, -2.93],
  Valencia: [39.47, -0.38],
};
const $ = (id) => document.getElementById(id);

async function actualizar() {
  const [lat, lon] = CIUDADES[$('ciudad').value];
  $('grados').textContent = '…';
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m`;
    const respuesta = await tdt.net.fetch(url);
    if (!respuesta.ok) throw new Error(`el servidor contestó ${respuesta.status}`);
    const { current } = respuesta.json();
    $('grados').textContent = `${Math.round(current.temperature_2m)} °C`;
    $('detalle').textContent = `Viento ${Math.round(current.wind_speed_10m)} km/h`;
    await tdt.storage.set('ultimo', { ciudad: $('ciudad').value, grados: current.temperature_2m, cuando: Date.now() });
  } catch (error) {
    const guardado = await tdt.storage.get('ultimo').catch(() => null);
    $('grados').textContent = guardado ? `${Math.round(guardado.grados)} °C` : '—';
    $('detalle').textContent = guardado ? 'Sin conexión: se muestra lo último guardado' : error.message;
    tdt.ui.toast('El tiempo: no se pudo consultar').catch(() => {});
  }
}

(async () => {
  await tdt.ready;
  for (const nombre of Object.keys(CIUDADES)) $('ciudad').append(new Option(nombre, nombre));
  const guardado = await tdt.storage.get('ultimo');
  if (guardado && CIUDADES[guardado.ciudad]) $('ciudad').value = guardado.ciudad;
  $('ciudad').addEventListener('change', actualizar);
  $('actualizar').addEventListener('click', actualizar);
  actualizar();
})();
