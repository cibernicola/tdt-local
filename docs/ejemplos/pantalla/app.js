// Ejemplo de plugin que ocupa la pantalla del reproductor ("placement": "screen" en el manifest).
// Es para el PC: todo se maneja con el ratón (clic en un canal, botón «Mezclar»). El teclado, además, mientras tiene el foco
// (se le da al abrirlo): 1-9 pone el canal de esa fila y M alterna entre fondo negro y transparente.
const $ = (id) => document.getElementById(id);
let canales = [];
let estado = null;

const hora = (ts) => new Date(ts * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

function poner(canal) {
  tdt.player.play(canal.id).catch((error) => console.error(error.message));
}

function mezclar(on = !document.body.classList.contains('mezcla')) {
  document.body.classList.toggle('mezcla', on);
  $('mezcla').setAttribute('aria-pressed', String(on));
}

function filas() {
  const activa = estado && (estado.tiles.find((t) => t.slot === estado.focus) || estado.tiles[0]);
  $('lista').replaceChildren(...canales.slice(0, 9).map((canal, i) => {
    const li = document.createElement('li');
    const boton = document.createElement('button');
    boton.type = 'button';
    boton.setAttribute('aria-current', String(!!activa && activa.id === canal.id));
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(i + 1);
    boton.append(num, canal.name); // textContent: el nombre viene de internet y no se interpreta como HTML
    boton.addEventListener('click', () => poner(canal));
    li.append(boton);
    return li;
  }));
}

async function pintar() {
  const activa = estado && (estado.tiles.find((t) => t.slot === estado.focus) || estado.tiles[0]);
  $('cabecera').textContent = 'TEXTO 100   ' + new Date().toLocaleTimeString('es-ES');
  $('canal').textContent = activa ? activa.name.toUpperCase() : 'NO HAY NADA EN PANTALLA';
  $('canal').className = activa ? 'amarillo' : 'rojo';
  $('ahora').textContent = '';
  $('luego').textContent = '';
  if (activa) {
    try {
      const guia = await tdt.epg.now(activa.name);
      if (guia.now) $('ahora').textContent = 'AHORA  ' + hora(guia.now.start) + ' ' + guia.now.title;
      if (guia.next) $('luego').textContent = 'LUEGO  ' + hora(guia.next.start) + ' ' + guia.next.title;
    } catch { /* sin guía para este canal */ }
  }
}

addEventListener('keydown', (e) => {
  if (/^[1-9]$/.test(e.key) && canales[Number(e.key) - 1]) poner(canales[Number(e.key) - 1]);
  else if (e.key === 'm' || e.key === 'M') mezclar();
});
$('mezcla').addEventListener('click', () => mezclar());
addEventListener('focus', () => $('pantalla').focus({ preventScroll: true }));

(async () => {
  await tdt.ready;
  canales = (await tdt.channels.search('', { kind: 'tv', limit: 9 })).channels;
  estado = await tdt.player.state();
  tdt.on('player', (nuevo) => { estado = nuevo; filas(); pintar(); });
  filas();
  pintar();
  setInterval(pintar, 1000); // el reloj y el programa
})().catch((error) => { $('canal').textContent = error.message; });
