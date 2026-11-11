// El plugin más pequeño que hace algo: dice qué canal hay en pantalla y saluda con un aviso.
const $ = (id) => document.getElementById(id);

function pintar(estado) {
  const activa = estado.tiles.find((t) => t.slot === estado.focus) || estado.tiles[0];
  $('canal').textContent = activa ? activa.name : 'Nada en pantalla';
}

(async () => {
  const yo = await tdt.ready; // { id, name, version, permissions }
  pintar(await tdt.player.state()); // permiso player.read
  tdt.on('player', pintar); // la aplicación avisa cuando cambia algo
  $('saludar').addEventListener('click', () => tdt.ui.toast('Hola desde ' + yo.name).catch(console.error)); // permiso ui.toast
})().catch((error) => {
  $('canal').textContent = error.message; // por ejemplo: permiso denegado: player.read
});
