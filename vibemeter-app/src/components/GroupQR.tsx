import { useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, Modal, StyleSheet, Platform, Alert } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import qrcode from 'qrcode-generator';
import { joinUrl, parseScan, ScanResult } from '../session/GroupCode';
import { supabase } from '../config/supabase';

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

/** Camera, with the permission step, that resolves the first Viibe Check code it sees. */
function ScanView({ active, onScan, hint }: {
  active: boolean;
  onScan: (scan: ScanResult) => void;
  hint: string;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [handled, setHandled] = useState(false);
  useEffect(() => { if (active) setHandled(false); }, [active]);

  const onScanned = ({ data }: { data: string }) => {
    if (handled) return;
    const scan = parseScan(data);
    if (!scan) return; // some other QR code: keep looking
    setHandled(true);
    onScan(scan);
  };

  if (!permission?.granted) {
    return (
      <View style={st.center}>
        <Text style={st.body}>Viibe Check needs the camera only to scan a group or venue code.</Text>
        <TouchableOpacity
          style={st.btn}
          onPress={async () => {
            const res = await requestPermission();
            if (!res.granted && !res.canAskAgain) {
              Alert.alert('Camera blocked', 'Allow camera access for Viibe Check in Settings, or type the code instead.');
            }
          }}
        >
          <Text style={st.btnText}>ALLOW CAMERA</Text>
        </TouchableOpacity>
      </View>
    );
  }
  return (
    <View style={{ flex: 1 }}>
      {active && (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handled ? undefined : onScanned}
        />
      )}
      <View style={st.scanHint}><Text style={st.body}>{hint}</Text></View>
    </View>
  );
}

/**
 * The Group sheet, before and during a session: SHOW MY CODE (a QR friends scan to join, with how
 * many phones are in the group) or SCAN (a friend's code, or a venue's code, which confirms the
 * venue and joins its crowd for the night).
 */
export function GroupSheet({ visible, code, onClose, onScan, onMakeVenueCode }: {
  visible: boolean;
  code: string | null;
  onClose: () => void;
  onScan: (scan: ScanResult) => Promise<string>;
  onMakeVenueCode?: () => void;
}) {
  const [mode, setMode] = useState<'show' | 'scan'>('show');
  const [count, setCount] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => { if (visible) { setMode('show'); setMessage(null); } }, [visible]);
  // How many phones are in the group, refreshed while the code is on screen
  useEffect(() => {
    if (!visible || mode !== 'show' || !code) return;
    let alive = true;
    const load = () => supabase.rpc('group_size', { p_code: code }).then(({ data }) => {
      if (alive && typeof data === 'number') setCount(data);
    });
    load();
    const id = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(id); };
  }, [visible, mode, code]);

  const handleScan = async (scan: ScanResult) => {
    const msg = await onScan(scan);
    setMessage(msg);
    setMode('show');
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={st.sheet}>
        <View style={st.toggle}>
          {(['show', 'scan'] as const).map(m => (
            <TouchableOpacity key={m} style={[st.toggleBtn, mode === m && st.toggleOn]} onPress={() => setMode(m)} activeOpacity={0.8}>
              <Text style={[st.toggleText, mode === m && { color: '#030904' }]}>{m === 'show' ? 'SHOW MY CODE' : 'SCAN'}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {mode === 'show' ? (
          <View style={{ flex: 1, justifyContent: 'center', padding: 22 }}>
            {message && <Text style={[st.body, { color: A, marginBottom: 14 }]}>{message}</Text>}
            <Text style={st.body}>
              Friends at the same party scan this to join your group, with their Camera app or with SCAN in Viibe Check.
            </Text>
            {code && <View style={{ alignItems: 'center', marginVertical: 18 }}><QRCodeView value={joinUrl(code)} size={240} /></View>}
            <Text selectable style={st.code}>{code ?? '—'}</Text>
            <Text style={[st.body, { color: TXD, fontSize: 12 }]}>
              {count == null ? ' ' : count === 0 ? 'No phone is measuring in this group yet' : `${count} ${count === 1 ? 'phone' : 'phones'} measuring in this group`}
            </Text>
            {onMakeVenueCode && (
              <TouchableOpacity onPress={onMakeVenueCode} style={{ alignItems: 'center', paddingVertical: 14 }}>
                <Text style={{ fontFamily: MONO, fontSize: 11, color: TXD, textDecorationLine: 'underline' }}>make a code for a venue →</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          <ScanView active={visible && mode === 'scan'} onScan={handleScan}
            hint="Point at a friend's Viibe Check code, or the venue's code" />
        )}

        <TouchableOpacity style={[st.btn, { backgroundColor: '#22222e', margin: 20, marginBottom: 36 }]} onPress={onClose}>
          <Text style={[st.btnText, { color: TX }]}>DONE</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  body: { fontSize: 14, color: '#c8c8dc', lineHeight: 21, textAlign: 'center' },
  code: { fontFamily: MONO, fontSize: 18, fontWeight: '700', color: TX, textAlign: 'center', letterSpacing: 3, marginBottom: 16 },
  btn: { height: 50, borderRadius: 14, backgroundColor: A, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  btnText: { fontFamily: MONO, fontSize: 12, fontWeight: '700', color: '#030904', letterSpacing: 2 },
  center: { flex: 1, justifyContent: 'center', padding: 28, gap: 16 },
  sheet: { flex: 1, backgroundColor: '#060608', paddingTop: 60 },
  toggle: { flexDirection: 'row', marginHorizontal: 20, backgroundColor: '#0d0d12', borderRadius: 14, padding: 4, borderWidth: 1, borderColor: '#181824' },
  toggleBtn: { flex: 1, height: 42, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  toggleOn: { backgroundColor: A },
  toggleText: { fontFamily: MONO, fontSize: 12, fontWeight: '700', color: TXD, letterSpacing: 1.5 },
  scanHint: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 20, backgroundColor: 'rgba(0,0,0,0.6)' },
});
