import { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, Modal, StyleSheet, Platform, Alert } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import qrcode from 'qrcode-generator';
import { joinUrl, parseGroupCode } from '../session/GroupCode';

const A = '#00E8A0';
const TX = '#f0f0f5';
const TXD = '#9898c0';
const MONO = Platform.select({ ios: 'Courier New', android: 'monospace' }) as string;

/** QR code drawn with plain views (no native SVG dependency). */
export function QRCodeView({ value, size = 220 }: { value: string; size?: number }) {
  const modules = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
  }, [value]);
  const quiet = 2; // light border, in modules, so cameras find the code
  const cell = Math.floor(size / (modules.length + quiet * 2));
  return (
    <View style={{ backgroundColor: '#fff', padding: cell * quiet, borderRadius: 8 }}>
      {modules.map((row, r) => (
        <View key={r} style={{ flexDirection: 'row' }}>
          {row.map((dark, c) => (
            <View key={c} style={{ width: cell, height: cell, backgroundColor: dark ? '#000' : '#fff' }} />
          ))}
        </View>
      ))}
    </View>
  );
}

/** Full-screen camera that resolves the first group QR code it sees. */
export function GroupScanner({ visible, onCode, onClose }: {
  visible: boolean;
  onCode: (code: string) => void;
  onClose: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [handled, setHandled] = useState(false);

  const onScanned = ({ data }: { data: string }) => {
    if (handled) return;
    const code = parseGroupCode(data, true);
    if (!code) return; // some other QR code: keep looking
    setHandled(true);
    onCode(code);
  };

  return (
    <Modal visible={visible} animationType="slide" onShow={() => setHandled(false)} onRequestClose={onClose}>
      <View style={st.scanRoot}>
        {permission?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={handled ? undefined : onScanned}
          />
        ) : (
          <View style={st.center}>
            <Text style={st.body}>ViibeMeter needs the camera only to scan a friend's group code.</Text>
            <TouchableOpacity
              style={st.btn}
              onPress={async () => {
                const res = await requestPermission();
                if (!res.granted && !res.canAskAgain) {
                  Alert.alert('Camera blocked', 'Allow camera access for ViibeMeter in Settings, or ask your friend to show you their code.');
                }
              }}
            >
              <Text style={st.btnText}>ALLOW CAMERA</Text>
            </TouchableOpacity>
          </View>
        )}
        <View style={st.scanFooter}>
          <Text style={st.body}>Point at the QR code on your friend's ViibeMeter screen</Text>
          <TouchableOpacity style={[st.btn, { backgroundColor: '#22222e' }]} onPress={onClose}>
            <Text style={[st.btnText, { color: TX }]}>CANCEL</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

/** Shows this session's group code as a QR for friends to scan, with a way to scan theirs. */
export function GroupSheet({ visible, code, onClose, onJoin }: {
  visible: boolean;
  code: string | null;
  onClose: () => void;
  onJoin: (code: string) => void;
}) {
  const [scanning, setScanning] = useState(false);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={st.overlay}>
        <View style={st.card}>
          <Text style={st.title}>YOUR GROUP</Text>
          <Text style={st.body}>
            Friends at the same party scan this to join your group. With the Camera app, or with “Scan” in ViibeMeter.
          </Text>
          {code && <View style={{ alignItems: 'center', marginVertical: 18 }}><QRCodeView value={joinUrl(code)} /></View>}
          <Text selectable style={st.code}>{code ?? '—'}</Text>
          <TouchableOpacity style={st.btn} onPress={() => setScanning(true)}>
            <Text style={st.btnText}>SCAN A FRIEND'S CODE</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onClose} style={{ alignItems: 'center', paddingVertical: 12 }}>
            <Text style={{ fontFamily: MONO, fontSize: 11, color: TXD }}>close</Text>
          </TouchableOpacity>
        </View>
      </View>
      <GroupScanner
        visible={scanning}
        onClose={() => setScanning(false)}
        onCode={c => { setScanning(false); onJoin(c); }}
      />
    </Modal>
  );
}

const st = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', padding: 20 },
  card: { backgroundColor: '#0d0d12', borderRadius: 20, borderWidth: 1, borderColor: A + '30', padding: 22 },
  title: { fontFamily: MONO, fontSize: 12, fontWeight: '700', color: A, letterSpacing: 2, marginBottom: 10 },
  body: { fontSize: 14, color: '#c8c8dc', lineHeight: 21, textAlign: 'center' },
  code: { fontFamily: MONO, fontSize: 18, fontWeight: '700', color: TX, textAlign: 'center', letterSpacing: 3, marginBottom: 16 },
  btn: { height: 50, borderRadius: 14, backgroundColor: A, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  btnText: { fontFamily: MONO, fontSize: 12, fontWeight: '700', color: '#030904', letterSpacing: 2 },
  scanRoot: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, justifyContent: 'center', padding: 28, gap: 16 },
  scanFooter: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 24, paddingBottom: 40, gap: 12, backgroundColor: 'rgba(0,0,0,0.6)' },
});
