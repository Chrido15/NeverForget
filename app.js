import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AppState,
  Linking,
  Modal,
  Platform,
  RefreshControl,
  SafeAreaView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  FlatList,
  ActivityIndicator,
  NativeModules,
  NativeEventEmitter,
} from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import * as Contacts from 'expo-contacts';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';

const { ContactsCreationDateModule, ContactsEventsModule } = NativeModules;
const contactsEvents = ContactsEventsModule
  ? new NativeEventEmitter(ContactsEventsModule)
  : null;

/* -------- persistent keys ---------- */
const FIRST_SEEN_KEY      = '@nf:firstSeen';
const TAGS_KEY            = '@nf:tags';
const PINS_KEY            = '@nf:pins';
const READY_KEY           = '@nf:ready';
const IMPORT_CHOICE_KEY   = '@nf:importChoice';

/* -------- helpers ---------- */
const loadJSON = async (k, fallback) => {
  try { const v = await AsyncStorage.getItem(k); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
};
const saveJSON = (k, obj) => AsyncStorage.setItem(k, JSON.stringify(obj));

const onlyDigits = (s='') => (s.match(/\d+/g) || []).join('');
const fmtAbs = (ms) => {
  try {
    const d = new Date(ms);
    return d.toLocaleString();
  } catch { return ''; }
};
const openPinInMaps = ({ latitude, longitude }, name='Location') => {
  const label = encodeURIComponent(name);
  const lat = latitude, lng = longitude;
  const url = Platform.select({
    ios:  `http://maps.apple.com/?ll=${lat},${lng}&q=${label}`,
    android: `geo:${lat},${lng}?q=${lat},${lng}(${label})`,
  });
  Linking.openURL(url);
};

/* -------- native "created" map (phone -> epoch) ---------- */
async function loadNativeCreated() {
  try {
    if (!ContactsCreationDateModule?.getPhoneDates) return {};
    const rows = await ContactsCreationDateModule.getPhoneDates();
    const map = {};
    for (const r of rows || []) {
      const t = Date.parse(r.creationDate);
      const phone = onlyDigits(r.phone);
      if (phone && Number.isFinite(t)) map[phone] = t;
    }
    return map;
  } catch {
    return {};
  }
}

export default function App() {
  /* ---------- state ---------- */
  const [perm, setPerm]                     = useState('undetermined');
  const [contacts, setContacts]             = useState([]);
  const [createdMap, setCreatedMap]         = useState({});
  const [firstSeen, setFirstSeen]           = useState({});
  const [tagsById, setTagsById]             = useState({});
  const [pinsById, setPinsById]             = useState({});
  const [loading, setLoading]               = useState(false);
  const [refreshing, setRefreshing]         = useState(false);

  const [search, setSearch]                 = useState('');
  const [view, setView]                     = useState('list'); // 'list' | 'map'

  const [showImportModal, setShowImportModal] = useState(false);
  const [importChoice, setImportChoice]       = useState(null);

  const [editingTagFor, setEditingTagFor]   = useState(null);
  const [tagText, setTagText]               = useState('');

  /* ---------- tag helpers ---------- */
  const addTag = useCallback(async (id, txt) => {
    const t = (txt || '').trim();
    if (!t) return;
    setTagsById(prev => {
      const next = { ...prev, [id]: Array.from(new Set([...(prev[id]||[]), t])) };
      saveJSON(TAGS_KEY, next);
      return next;
    });
  }, []);

  const removeTag = useCallback(async (id, t) => {
    setTagsById(prev => {
      const next = { ...prev, [id]: (prev[id]||[]).filter(x => x !== t) };
      saveJSON(TAGS_KEY, next);
      return next;
    });
  }, []);

  /* ---------- created-time resolution ---------- */
  const getCreatedTime = useCallback((c) => {
    const num = onlyDigits(c?.phoneNumbers?.[0]?.number);
    if (num && createdMap[num]) return createdMap[num];
    if (firstSeen[c.id]) return firstSeen[c.id];
    return 0;
  }, [createdMap, firstSeen]);

  /* ---------- fetch contacts ---------- */
  const fetchContacts = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    setRefreshing(isRefresh);

    try {
      const permState = await Contacts.getPermissionsAsync();
      let status = permState.status;
      let granted = status === 'granted';
      if (!granted && (status === 'undetermined' || permState.canAskAgain)) {
        const req = await Contacts.requestPermissionsAsync();
        status = req.status;
        granted = status === 'granted';
      }
      setPerm(status);
      if (!granted) return;

      const [result, nativeCreated, fs, tags, pins] = await Promise.all([
        Contacts.getContactsAsync({ fields: [Contacts.Fields.PhoneNumbers] }),
        loadNativeCreated(),
        loadJSON(FIRST_SEEN_KEY, {}),
        loadJSON(TAGS_KEY, {}),
        loadJSON(PINS_KEY, {}),
      ]);

      setCreatedMap(nativeCreated);
      setTagsById(tags);
      setPinsById(pins);

      let fsMap = { ...fs };
      const ready = await AsyncStorage.getItem(READY_KEY);

      if (importChoice === 'all') {
        const now = Date.now();
        const newIds = [];
        for (const c of result.data) {
          if (!fsMap[c.id]) {
            fsMap[c.id] = now;
            newIds.push(c.id);
          }
        }
        if (!ready) await AsyncStorage.setItem(READY_KEY, '1');
        if (newIds.length) await saveJSON(FIRST_SEEN_KEY, fsMap);
        setFirstSeen(fsMap);
        setContacts(result.data);
      } else if (importChoice === 'newOnly') {
        const readyTimestamp = await AsyncStorage.getItem(READY_KEY);
        
        console.log('=== newOnly mode ===');
        console.log('readyTimestamp:', readyTimestamp);
        console.log('Total contacts from device:', result.data.length);
        
        if (!readyTimestamp) {
          // First time - mark all existing as seen but don't show them
          const cutoffTime = Date.now();
          console.log('First run - setting cutoff time:', cutoffTime);
          
          for (const c of result.data) {
            fsMap[c.id] = cutoffTime; // Mark ALL existing contacts with cutoff time
          }
          
          await AsyncStorage.setItem(READY_KEY, cutoffTime.toString());
          await saveJSON(FIRST_SEEN_KEY, fsMap);
          setFirstSeen(fsMap);
          setContacts([]); // Show empty list initially
          console.log('Set contacts to empty array');
        } else {
          // Subsequent fetches - only show contacts added AFTER cutoff
          const cutoffTime = parseInt(readyTimestamp);
          console.log('Using cutoff time:', cutoffTime, new Date(cutoffTime));
          const now = Date.now();
          let newContactIds = [];
          
          for (const c of result.data) {
            if (!fsMap[c.id]) {
              // This is a NEW contact (not in our firstSeen map)
              fsMap[c.id] = now;
              newContactIds.push(c.id);
            }
          }
          
          if (newContactIds.length > 0) {
            console.log('Found new contacts:', newContactIds.length);
            await saveJSON(FIRST_SEEN_KEY, fsMap);
          }
          
          setFirstSeen(fsMap);
          
          // Only show contacts that were first seen AFTER the cutoff
          const filteredContacts = result.data.filter(c => {
            const seenTime = fsMap[c.id];
            const shouldShow = seenTime && seenTime > cutoffTime;
            if (shouldShow) {
              console.log('Showing contact:', c.name, 'seen at:', new Date(seenTime));
            }
            return shouldShow;
          });
          
          console.log('Filtered contacts count:', filteredContacts.length);
          setContacts(filteredContacts);
        }
      } else {
        setFirstSeen(fsMap);
        setContacts(result.data);
      }
    } catch (error) {
      console.error('fetchContacts error:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [importChoice]);

  /* ---------- bootstrap ---------- */
  useEffect(() => {
    const run = async () => {
      // Request contacts permission
      const p = await Contacts.getPermissionsAsync();
      let status = p.status;
      if (status !== 'granted' && (status === 'undetermined' || p.canAskAgain)) {
        const r = await Contacts.requestPermissionsAsync();
        status = r.status;
      }
      setPerm(status);

      if (status !== 'granted') {
        setShowImportModal(false);
        return;
      }

      // Request location permission upfront
      const locPerm = await Location.getForegroundPermissionsAsync();
      if (locPerm.status !== 'granted' && locPerm.canAskAgain) {
        await Location.requestForegroundPermissionsAsync();
      }

      const choice = await AsyncStorage.getItem(IMPORT_CHOICE_KEY);
      setImportChoice(choice);
      
      // Show import modal AFTER permission is granted and if no choice exists
      if (!choice) {
        setShowImportModal(true);
      } else {
        await fetchContacts(false);
      }
    };

    run();
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') run();
    });
    return () => sub.remove();
  }, [fetchContacts]);

  /* ---------- Contact change detection - auto-add with location ---------- */
  useEffect(() => {
    if (!contactsEvents) return;

    const sub = contactsEvents.addListener('ContactsChanged', async () => {
      const current = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.PhoneNumbers]
      });

      const currentIds = new Set(current.data.map(c => c.id));
      const prevIds = new Set(contacts.map(c => c.id));
      const newIds = [...currentIds].filter(id => !prevIds.has(id));

      if (newIds.length > 0) {
        // Automatically get location and add contacts - no alert
        try {
          const { status } = await Location.getForegroundPermissionsAsync();
          
          if (status === 'granted') {
            const pos = await Location.getCurrentPositionAsync({
              accuracy: Location.Accuracy.Balanced
            });

            const { latitude, longitude } = pos.coords;
            const timestamp = Date.now();

            setPinsById(prev => {
              const next = { ...prev };
              for (const id of newIds) {
                next[id] = { latitude, longitude, timestamp };
              }
              saveJSON(PINS_KEY, next);
              return next;
            });

            setFirstSeen(prev => {
              const next = { ...prev };
              for (const id of newIds) {
                if (!next[id]) next[id] = timestamp;
              }
              saveJSON(FIRST_SEEN_KEY, next);
              return next;
            });
          }
        } catch (error) {
          console.error('Location error:', error);
        }
        
        // Refresh contacts list
        fetchContacts(true);
      }
    });

    return () => sub.remove();
  }, [contacts, fetchContacts]);

  /* ---------- Handle native module events (location from Swift) ---------- */
  useEffect(() => {
    if (!contactsEvents) return;

    const sub = contactsEvents.addListener(
      'ContactAddedWithLocation',
      async (payload) => {
        console.log('ContactAddedWithLocation event received:', payload);
        const { id, lat, lng, timestamp } = payload || {};
        const ts = Number.isFinite(timestamp) ? timestamp : Date.now();

        setFirstSeen(prev => {
          const next = { ...prev, [id]: ts };
          saveJSON(FIRST_SEEN_KEY, next);
          return next;
        });

        setPinsById(prev => {
          const next = { ...prev, [id]: { latitude: lat, longitude: lng, timestamp: ts } };
          console.log('Saving pin for contact:', id, { latitude: lat, longitude: lng });
          saveJSON(PINS_KEY, next);
          return next;
        });

        await fetchContacts(true);
      }
    );

    return () => sub.remove();
  }, [fetchContacts]);

  /* ---------- UI data - SORTED BY DATE ---------- */
  const data = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = q
      ? contacts.filter(c => {
          const nameHit = (c.name || '').toLowerCase().includes(q);
          const tagHit = (tagsById[c.id] || []).some(t => t.toLowerCase().includes(q));
          return nameHit || tagHit;
        })
      : contacts.slice();

    // Always sort by created date (most recent first)
    base.sort((a, b) => {
      const ta = getCreatedTime(a), tb = getCreatedTime(b);
      const ha = ta > 0, hb = tb > 0;
      if (ha && hb) return tb - ta; // Both have times: newer first
      if (ha && !hb) return -1;     // Only a has time: a first
      if (!ha && hb) return 1;      // Only b has time: b first
      return (a.name || '').localeCompare(b.name || ''); // Neither: alphabetical
    });

    return base;
  }, [contacts, search, tagsById, getCreatedTime]);

  // Contacts with pins for map view
  const contactsWithPins = useMemo(() => {
    return data.filter(c => pinsById[c.id]);
  }, [data, pinsById]);

  // Calculate map region
  const mapRegion = useMemo(() => {
    if (contactsWithPins.length === 0) {
      return {
        latitude: 39.7392,
        longitude: -104.9903,
        latitudeDelta: 0.5,
        longitudeDelta: 0.5,
      };
    }

    const lats = contactsWithPins.map(c => pinsById[c.id].latitude);
    const lngs = contactsWithPins.map(c => pinsById[c.id].longitude);

    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);

    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLng + maxLng) / 2,
      latitudeDelta: Math.max(maxLat - minLat, 0.05) * 1.5,
      longitudeDelta: Math.max(maxLng - minLng, 0.05) * 1.5,
    };
  }, [contactsWithPins, pinsById]);

  /* ---------- render ---------- */
  if (perm !== 'granted') {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.title}>Recently</Text>
        <Text style={{ textAlign: 'center', marginTop: 8 }}>
          NeverForget needs access to Contacts.
        </Text>
        <TouchableOpacity style={styles.cta} onPress={() => Linking.openSettings()}>
          <Text style={styles.ctaText}>Open Settings</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>Recently</Text>

      <TextInput
        value={search}
        onChangeText={setSearch}
        placeholder="Search name or tag…"
        autoCapitalize="none"
        style={styles.search}
      />

      <View style={styles.tabs}>
        <TouchableOpacity
          onPress={() => setView('list')}
          style={[styles.tab, view === 'list' && styles.tabActive]}
        >
          <Text style={[styles.tabText, view === 'list' && styles.tabTextActive]}>Created</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setView('map')}
          style={[styles.tab, view === 'map' && styles.tabActive]}
        >
          <Text style={[styles.tabText, view === 'map' && styles.tabTextActive]}>Map</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator />
          <Text style={{ marginTop: 6 }}>Loading contacts…</Text>
        </View>
      ) : view === 'map' ? (
        <View style={styles.mapContainer}>
          {contactsWithPins.length === 0 ? (
            <View style={styles.emptyMap}>
              <Text style={styles.empty}>No contacts with location data</Text>
              <Text style={styles.emptyHint}>Add a contact and save its location to see it here</Text>
            </View>
          ) : (
            <MapView
              style={styles.map}
              initialRegion={mapRegion}
              showsUserLocation
              showsMyLocationButton
            >
              {contactsWithPins.map((contact) => {
                const pin = pinsById[contact.id];
                const tags = tagsById[contact.id] || [];
                const tagText = tags.length > 0 ? ` • ${tags.join(', ')}` : '';
                
                return (
                  <Marker
                    key={contact.id}
                    coordinate={{
                      latitude: pin.latitude,
                      longitude: pin.longitude,
                    }}
                    title={contact.name || '(No name)'}
                    description={`${contact.phoneNumbers?.[0]?.number || ''}${tagText}`}
                    onCalloutPress={() => openPinInMaps(pin, contact.name || 'Contact')}
                  />
                );
              })}
            </MapView>
          )}
        </View>
      ) : (
        <FlatList
          data={data}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => fetchContacts(true)} />
          }
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          ListEmptyComponent={<Text style={styles.empty}>No contacts</Text>}
          renderItem={({ item }) => {
            const when = getCreatedTime(item);
            const tags = tagsById[item.id] || [];
            const pin = pinsById[item.id];

            return (
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{item.name || '(No name)'}</Text>
                  {!!item.phoneNumbers?.length && (
                    <Text style={styles.sub}>{item.phoneNumbers[0]?.number}</Text>
                  )}

                  <View style={styles.tagsRow}>
                    {tags.map((t) => (
                      <TouchableOpacity
                        key={t}
                        onLongPress={() => removeTag(item.id, t)}
                        style={styles.tagChip}
                      >
                        <Text style={styles.tagText}>{t}</Text>
                      </TouchableOpacity>
                    ))}
                    {editingTagFor === item.id ? (
                      <View style={styles.tagEditor}>
                        <TextInput
                          style={styles.tagInput}
                          placeholder="Add tag"
                          value={tagText}
                          onChangeText={setTagText}
                          onSubmitEditing={async () => {
                            await addTag(item.id, tagText);
                            setTagText('');
                            setEditingTagFor(null);
                          }}
                          autoCapitalize="none"
                        />
                        <TouchableOpacity
                          onPress={async () => {
                            await addTag(item.id, tagText);
                            setTagText('');
                            setEditingTagFor(null);
                          }}
                          style={styles.tagSave}
                        >
                          <Text style={styles.tagSaveText}>Add</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => {
                            setTagText('');
                            setEditingTagFor(null);
                          }}
                        >
                          <Text style={styles.tagCancel}>Cancel</Text>
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <TouchableOpacity
                        onPress={() => setEditingTagFor(item.id)}
                        style={styles.tagAdd}
                      >
                        <Text style={styles.tagAddText}>+ Tag</Text>
                      </TouchableOpacity>
                    )}

                    {pin && (
                      <TouchableOpacity
                        onPress={() => openPinInMaps(pin, item.name || 'Contact')}
                        style={styles.mapButton}
                      >
                        <Text style={styles.mapButtonText}>Open in Maps</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>

                <Text style={styles.badge}>{when ? fmtAbs(when) : ''}</Text>
              </View>
            );
          }}
        />
      )}

      <Modal transparent visible={showImportModal} animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>How should we start?</Text>
            <Text style={styles.modalP}>
              • <Text style={{ fontWeight: '600' }}>Import existing</Text>: show all your current contacts now.
            </Text>
            <Text style={styles.modalP}>
              • <Text style={{ fontWeight: '600' }}>Only new</Text>: only track contacts you add from now on.
            </Text>
            <View style={{ height: 12 }} />
            <TouchableOpacity
              style={styles.cta}
              onPress={async () => {
                await AsyncStorage.setItem(IMPORT_CHOICE_KEY, 'all');
                setImportChoice('all');
                setShowImportModal(false);
                await fetchContacts(false);
              }}
            >
              <Text style={styles.ctaText}>Import existing</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.cta, { backgroundColor: '#444' }]}
              onPress={async () => {
                const cutoffTime = Date.now();
                console.log('User chose newOnly, setting cutoff:', cutoffTime);
                await AsyncStorage.setItem(IMPORT_CHOICE_KEY, 'newOnly');
                await AsyncStorage.setItem(READY_KEY, cutoffTime.toString());
                
                // Mark all existing contacts as seen with cutoff time
                const fs = await loadJSON(FIRST_SEEN_KEY, {});
                const result = await Contacts.getContactsAsync({ 
                  fields: [Contacts.Fields.PhoneNumbers] 
                });
                
                for (const c of result.data) {
                  fs[c.id] = cutoffTime;
                }
                await saveJSON(FIRST_SEEN_KEY, fs);
                
                setImportChoice('newOnly');
                setShowImportModal(false);
                await fetchContacts(false);
              }}
            >
              <Text style={styles.ctaText}>Only new going forward</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

/* ---------- styles ---------- */
const styles = {
  container: { flex: 1, backgroundColor: '#fff', paddingHorizontal: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 28, fontWeight: '800', marginTop: 8, marginBottom: 10 },
  search: { borderWidth: 1, borderColor: '#ddd', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 10 },
  tabs: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  tab: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, backgroundColor: '#eee' },
  tabActive: { backgroundColor: '#111' },
  tabText: { fontWeight: '700', color: '#111', fontSize: 14 },
  tabTextActive: { color: '#fff' },
  loading: { alignItems: 'center', marginTop: 40 },
  sep: { height: 1, backgroundColor: '#eee' },
  empty: { textAlign: 'center', marginTop: 32, color: '#666', fontSize: 16 },
  emptyHint: { textAlign: 'center', marginTop: 8, color: '#999', fontSize: 14 },
  row: { flexDirection: 'row', paddingVertical: 10, gap: 10 },
  name: { fontSize: 16, fontWeight: '700' },
  sub: { color: '#666', marginTop: 2, fontSize: 14 },
  badge: { alignSelf: 'flex-start', color: '#666', fontSize: 12 },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8, alignItems: 'center' },
  tagChip: { backgroundColor: '#f0f0f0', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  tagText: { fontWeight: '600', color: '#333', fontSize: 12 },
  tagAdd: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: '#e8f0ff' },
  tagAddText: { fontWeight: '700', color: '#3366ff', fontSize: 12 },
  mapButton: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: '#e8f0ff' },
  mapButtonText: { fontWeight: '700', color: '#3366ff', fontSize: 12 },
  tagEditor: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tagInput: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, minWidth: 120, fontSize: 14 },
  tagSave: { backgroundColor: '#111', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  tagSaveText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  tagCancel: { color: '#666', fontSize: 12 },
  mapContainer: { flex: 1, borderRadius: 12, overflow: 'hidden', marginTop: 8 },
  map: { flex: 1 },
  emptyMap: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f9f9f9' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center' },
  modalCard: { width: '86%', backgroundColor: '#fff', borderRadius: 16, padding: 18 },
  modalTitle: { fontSize: 18, fontWeight: '800', marginBottom: 8 },
  modalP: { color: '#333', marginTop: 4, fontSize: 14 },
  cta: { backgroundColor: '#111', paddingVertical: 10, borderRadius: 10, marginTop: 10, alignItems: 'center' },
  ctaText: { color: '#fff', fontWeight: '800', fontSize: 16 },
};