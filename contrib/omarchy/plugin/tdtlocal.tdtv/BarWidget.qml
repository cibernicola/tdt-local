import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// TDT local widget. State: `tdtv status --json` every 3 s (mpv over its IPC socket).
// Left click: pause/resume (opens the app if nothing is playing) · right click: open the web app
// Middle click: stop · wheel: volume ±5 · Ctrl+wheel: next/previous channel
BarWidget {
  id: root
  moduleName: "tdtlocal.tdtv"

  property var st: ({ playing: false })
  readonly property bool playing: st.playing === true
  readonly property bool paused: playing && st.paused === true
  readonly property string channel: st.channel ? String(st.channel) : ""
  readonly property string program: st.now && st.now.title ? String(st.now.title) : ""
  readonly property string label: playing ? channel + (program ? " · " + program : "") : "TDT"
  readonly property real maxLabelWidth: Style.space(190)
  readonly property color ink: bar ? bar.barForeground : Color.foreground

  implicitWidth: row.implicitWidth + Style.space(14)
  implicitHeight: barSize

  function run(args) {
    Quickshell.execDetached(["tdtv"].concat(args))
    refreshSoon.restart()
  }

  Process {
    id: poll
    command: ["tdtv", "status", "--json"]
    running: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        try { root.st = JSON.parse(text) } catch (e) { root.st = ({ playing: false }) }
      }
    }
  }
  Timer { interval: 3000; running: true; repeat: true; triggeredOnStart: true; onTriggered: if (!poll.running) poll.running = true }
  Timer { id: refreshSoon; interval: 900; onTriggered: if (!poll.running) poll.running = true }

  Row {
    id: row
    anchors.centerIn: parent
    spacing: Style.space(6)

    Text {
      id: glyph
      anchors.verticalCenter: parent.verticalCenter
      text: !root.playing ? "󰟞" : (root.paused ? "󰏤" : "󰕼")
      color: root.playing ? root.ink : Qt.darker(root.ink, 1.5)
      font.family: root.bar ? root.bar.fontFamily : Style.font.family
      font.pixelSize: Style.font.body
      renderType: Text.NativeRendering
    }
    Item {
      visible: root.playing && !root.vertical
      width: Math.min(root.maxLabelWidth, labelText.implicitWidth)
      height: glyph.height
      clip: true
      anchors.verticalCenter: parent.verticalCenter
      Text {
        id: labelText
        text: root.label
        textFormat: Text.PlainText
        color: root.ink
        opacity: root.paused ? 0.6 : 1.0
        font.family: root.bar ? root.bar.fontFamily : Style.font.family
        font.pixelSize: Style.font.body
        anchors.verticalCenter: parent.verticalCenter
        renderType: Text.NativeRendering
        property bool needsScroll: implicitWidth > root.maxLabelWidth
        NumberAnimation on x {
          running: labelText.needsScroll && !root.paused
          loops: Animation.Infinite
          duration: Math.max(7000, labelText.implicitWidth * 28)
          from: root.maxLabelWidth
          to: -labelText.implicitWidth
          easing.type: Easing.Linear
        }
      }
    }
  }

  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    acceptedButtons: Qt.LeftButton | Qt.RightButton | Qt.MiddleButton
    onClicked: function(mouse) {
      if (mouse.button === Qt.RightButton) root.run(["web"])
      else if (mouse.button === Qt.MiddleButton) root.run(["stop"])
      else if (root.playing) root.run(["toggle"])
      else root.run(["web"])
    }
    onWheel: function(wheel) {
      var up = wheel.angleDelta.y > 0
      if (!root.playing) return
      if (wheel.modifiers & Qt.ControlModifier) root.run([up ? "next" : "prev"])
      else root.run(["vol", up ? "+5" : "-5"])
    }
    onEntered: if (root.bar) root.bar.showTooltip(root, root.playing
      ? root.channel + (root.program ? " — " + root.program : "") + "  (vol " + Math.round(root.st.volume || 0) + "%)\nClic: pausa · Dcho: app · Central: parar · Rueda: volumen · Ctrl+rueda: canal"
      : "TDT — clic para abrir la app")
    onExited: if (root.bar) root.bar.hideTooltip(root)
  }
}
