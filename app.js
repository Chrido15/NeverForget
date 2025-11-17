/**
 * NeverForget - Main Application
 * 
 * Purpose: Contact tracking application that automatically captures location
 *          when contacts are added to the device.
 * 
 * Author: Bryce Christian
 * Course: SENG 564
 * Date: November 16, 2025
 * 
 * Clean Code Principles Applied:
 * - Meaningful names that reveal intent
 * - Functions do one thing
 * - Comments explain "why", not "what"
 * - DRY (Don't Repeat Yourself)
 * - Error handling with try-catch
 */

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

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * AsyncStorage persistence keys
 * Prefixed with @nf: to avoid collisions with other apps
 */
const STORAGE_KEYS = {
  FIRST_SEEN: '@nf:firstSeen',      // When contact was first seen by app
  TAGS: '@nf:tags',                 // User-created tags per contact
  PINS: '@nf:pins',                 // Location pins for contacts
  READY: '@nf:ready',               // Timestamp when app was initialized
  IMPORT_CHOICE: '@nf:importChoice' // 'all' | 'newOnly'
};

/**
 * Native modules for enhanced contact functionality
 */
const { ContactsCreationDateModule, ContactsEventsModule } = NativeModules;

/**
 * Event emitter for real-time contact change notifications
 */
const contactsEventEmitter = ContactsEventsModule
  ? new NativeEventEmitter(ContactsEventsModule)
  : null;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Loads and parses JSON data from AsyncStorage
 * 
 * @param {string} key - Storage key
 * @param {*} fallbackValue - Default value if key doesn't exist
 * @returns {Promise<*>} Parsed data or fallback
 */
const loadJSON = async (key, fallbackValue) => {
  try {
    const value = await AsyncStorage.getItem(key);
    return value ? JSON.parse(value) : fallbackValue;
  } catch (error) {
    console.error(`Failed to load ${key}:`, error);
    return fallbackValue;
  }
};

/**
 * Saves data to AsyncStorage as JSON
 * 
 * @param {string} key - Storage key
 * @param {*} data - Data to serialize and save
 */
const saveJSON = (key, data) => {
  AsyncStorage.setItem(key, JSON.stringify(data));
};

/**
 * Extracts only digits from a phone number string
 * 
 * Why: Phone numbers can have various formats (+1-303-555-1212)
 *      but we need consistent comparison (13035551212)
 * 
 * @param {string} phoneNumber - Formatted phone number
 * @returns {string} Digits only
 */
const extractDigitsOnly = (phoneNumber = '') => {
  return (phoneNumber.match(/\d+/g) || []).join('');
};

/**
 * Formats epoch timestamp as localized datetime string
 * 
 * @param {number} milliseconds - Epoch timestamp
 * @returns {string} Formatted date/time or empty string on error
 */
const formatAbsoluteTime = (milliseconds) => {
  try {
    return new Date(milliseconds).toLocaleString();
  } catch {
    return '';
  }
};

/**
 * Opens device's native maps app with coordinates
 * 
 * @param {Object} location - Location object with latitude/longitude
 * @param {string} label - Label for the map pin
 */
const openLocationInNativeMaps = ({ latitude, longitude }, label = 'Location') => {
  const encodedLabel = encodeURIComponent(label);
  const url = Platform.select({
    ios: `http://maps.apple.com/?ll=${latitude},${longitude}&q=${encodedLabel}`,
    android: `geo:${latitude},${longitude}?q=${latitude},${longitude}(${encodedLabel})`,
  });
  Linking.openURL(url);
};

/**
 * Fetches contact creation dates from native AddressBook
 * 
 * Why: CNContacts API doesn't expose creation dates, but deprecated
 *      AddressBook still works and provides this metadata
 * 
 * @returns {Promise<Object>} Map of phone number (digits) to creation timestamp
 */
async function loadNativeContactCreationDates() {
  try {
    if (!ContactsCreationDateModule?.getPhoneDates) {
      return {};
    }
    
    const rows = await ContactsCreationDateModule.getPhoneDates();
    const phoneToTimestampMap = {};
    
    for (const row of rows || []) {
      const timestamp = Date.parse(row.creationDate);
      const digitsOnly = extractDigitsOnly(row.phone);
      
      if (digitsOnly && Number.isFinite(timestamp)) {
        phoneToTimestampMap[digitsOnly] = timestamp;
      }
    }
    
    return phoneToTimestampMap;
  } catch (error) {
    console.error('Failed to load native creation dates:', error);
    return {};
  }
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

/**
 * NeverForget Application
 * 
 * Responsibilities:
 * - Manage contact permissions
 * - Track when contacts are added
 * - Capture location at contact creation time
 * - Display contacts in list and map views
 * - Support tagging and filtering
 */
export default function App() {
  // --------------------------------------------------------------------------
  // STATE
  // --------------------------------------------------------------------------
  
  const [contactPermission, setContactPermission] = useState('undetermined');
  const [contacts, setContacts] = useState([]);
  const [nativeCreationDates, setNativeCreationDates] = useState({});
  const [firstSeenTimestamps, setFirstSeenTimestamps] = useState({});
  const [tagsByContactId, setTagsByContactId] = useState({});
  const [locationPinsByContactId, setLocationPinsByContactId] = useState({});
  const [isLoadingContacts, setIsLoadingContacts] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  
  const [searchQuery, setSearchQuery] = useState('');
  const [currentView, setCurrentView] = useState('list'); // 'list' | 'map'
  
  const [showImportModal, setShowImportModal] = useState(false);
  const [importMode, setImportMode] = useState(null); // 'all' | 'newOnly'
  
  const [contactBeingTagged, setContactBeingTagged] = useState(null);
  const [tagInputText, setTagInputText] = useState('');

  // --------------------------------------------------------------------------
  // TAG MANAGEMENT
  // --------------------------------------------------------------------------
  
  /**
   * Adds a tag to a contact
   * 
   * @param {string} contactId - Unique contact identifier
   * @param {string} tagText - Tag to add
   */
  const addTagToContact = useCallback(async (contactId, tagText) => {
    const trimmedTag = (tagText || '').trim();
    if (!trimmedTag) return;
    
    setTagsByContactId(previousTags => {
      const existingTags = previousTags[contactId] || [];
      const updatedTags = Array.from(new Set([...existingTags, trimmedTag]));
      const newTagState = { ...previousTags, [contactId]: updatedTags };
      
      saveJSON(STORAGE_KEYS.TAGS, newTagState);
      return newTagState;
    });
  }, []);

  /**
   * Removes a tag from a contact
   * 
   * @param {string} contactId - Unique contact identifier
   * @param {string} tagToRemove - Tag to remove
   */
  const removeTagFromContact = useCallback(async (contactId, tagToRemove) => {
    setTagsByContactId(previousTags => {
      const filteredTags = (previousTags[contactId] || []).filter(
        tag => tag !== tagToRemove
      );
      const newTagState = { ...previousTags, [contactId]: filteredTags };
      
      saveJSON(STORAGE_KEYS.TAGS, newTagState);
      return newTagState;
    });
  }, []);

  // --------------------------------------------------------------------------
  // CONTACT TIMESTAMP RESOLUTION
  // --------------------------------------------------------------------------
  
  /**
   * Determines when a contact was created
   * 
   * Priority:
   * 1. Native creation date from AddressBook (most accurate)
   * 2. First seen timestamp (when app first saw this contact)
   * 3. 0 (unknown/not tracked)
   * 
   * @param {Object} contact - Contact object from Expo Contacts
   * @returns {number} Creation timestamp or 0
   */
  const getContactCreationTime = useCallback((contact) => {
    // Try to get native creation date via phone number
    const phoneDigits = extractDigitsOnly(contact?.phoneNumbers?.[0]?.number);
    if (phoneDigits && nativeCreationDates[phoneDigits]) {
      return nativeCreationDates[phoneDigits];
    }
    
    // Fall back to first seen timestamp
    if (firstSeenTimestamps[contact.id]) {
      return firstSeenTimestamps[contact.id];
    }
    
    return 0; // Unknown
  }, [nativeCreationDates, firstSeenTimestamps]);

  // --------------------------------------------------------------------------
  // CONTACT FETCHING
  // --------------------------------------------------------------------------
  
  /**
   * Fetches contacts from device and applies import mode filtering
   * 
   * This function:
   * - Requests contacts permission if needed
   * - Loads all device contacts
   * - Loads persisted metadata (tags, pins, timestamps)
   * - Applies import mode logic (all vs. newOnly)
   * - Updates state
   * 
   * @param {boolean} isRefreshAction - True if user manually refreshed
   */
  const fetchContactsFromDevice = useCallback(async (isRefreshAction = false) => {
    if (!isRefreshAction) setIsLoadingContacts(true);
    setIsRefreshing(isRefreshAction);

    try {
      // Request contacts permission
      const permissionState = await Contacts.getPermissionsAsync();
      let permissionStatus = permissionState.status;
      let isGranted = permissionStatus === 'granted';
      
      if (!isGranted && (permissionStatus === 'undetermined' || permissionState.canAskAgain)) {
        const requestResult = await Contacts.requestPermissionsAsync();
        permissionStatus = requestResult.status;
        isGranted = permissionStatus === 'granted';
      }
      
      setContactPermission(permissionStatus);
      if (!isGranted) return;

      // Fetch all data in parallel for performance
      const [
        contactsResult,
        nativeDates,
        firstSeenMap,
        tagsMap,
        pinsMap
      ] = await Promise.all([
        Contacts.getContactsAsync({ fields: [Contacts.Fields.PhoneNumbers] }),
        loadNativeContactCreationDates(),
        loadJSON(STORAGE_KEYS.FIRST_SEEN, {}),
        loadJSON(STORAGE_KEYS.TAGS, {}),
        loadJSON(STORAGE_KEYS.PINS, {}),
      ]);

      setNativeCreationDates(nativeDates);
      setTagsByContactId(tagsMap);
      setLocationPinsByContactId(pinsMap);

      let firstSeenWorkingCopy = { ...firstSeenMap };
      const readyTimestamp = await AsyncStorage.getItem(STORAGE_KEYS.READY);

      // Apply import mode logic
      if (importMode === 'all') {
        // Import all contacts: timestamp any new ones, show all
        const now = Date.now();
        const newContactIds = [];
        
        for (const contact of contactsResult.data) {
          if (!firstSeenWorkingCopy[contact.id]) {
            firstSeenWorkingCopy[contact.id] = now;
            newContactIds.push(contact.id);
          }
        }
        
        if (!readyTimestamp) {
          await AsyncStorage.setItem(STORAGE_KEYS.READY, '1');
        }
        if (newContactIds.length) {
          await saveJSON(STORAGE_KEYS.FIRST_SEEN, firstSeenWorkingCopy);
        }
        
        setFirstSeenTimestamps(firstSeenWorkingCopy);
        setContacts(contactsResult.data);
        
      } else if (importMode === 'newOnly') {
        // Only new contacts: mark existing as seen, filter to show only new
        
        if (!readyTimestamp) {
          // First run: mark all existing contacts with cutoff time
          const cutoffTime = Date.now();
          console.log('First run - setting cutoff time:', cutoffTime);
          
          for (const contact of contactsResult.data) {
            firstSeenWorkingCopy[contact.id] = cutoffTime;
          }
          
          await AsyncStorage.setItem(STORAGE_KEYS.READY, cutoffTime.toString());
          await saveJSON(STORAGE_KEYS.FIRST_SEEN, firstSeenWorkingCopy);
          setFirstSeenTimestamps(firstSeenWorkingCopy);
          setContacts([]); // Show empty list initially
          console.log('Set contacts to empty array');
          
        } else {
          // Subsequent runs: only show contacts added AFTER cutoff
          const cutoffTime = parseInt(readyTimestamp);
          console.log('Using cutoff time:', cutoffTime, new Date(cutoffTime));
          const now = Date.now();
          const newContactIds = [];
          
          for (const contact of contactsResult.data) {
            if (!firstSeenWorkingCopy[contact.id]) {
              firstSeenWorkingCopy[contact.id] = now;
              newContactIds.push(contact.id);
            }
          }
          
          if (newContactIds.length > 0) {
            console.log('Found new contacts:', newContactIds.length);
            await saveJSON(STORAGE_KEYS.FIRST_SEEN, firstSeenWorkingCopy);
          }
          
          setFirstSeenTimestamps(firstSeenWorkingCopy);
          
          // Filter to only contacts seen AFTER cutoff
          const filteredContacts = contactsResult.data.filter(contact => {
            const seenTime = firstSeenWorkingCopy[contact.id];
            const shouldShow = seenTime && seenTime > cutoffTime;
            if (shouldShow) {
              console.log('Showing contact:', contact.name, 'seen at:', new Date(seenTime));
            }
            return shouldShow;
          });
          
          console.log('Filtered contacts count:', filteredContacts.length);
          setContacts(filteredContacts);
        }
      } else {
        // No import mode selected yet
        setFirstSeenTimestamps(firstSeenWorkingCopy);
        setContacts(contactsResult.data);
      }
      
    } catch (error) {
      console.error('fetchContacts error:', error);
    } finally {
      setIsLoadingContacts(false);
      setIsRefreshing(false);
    }
  }, [importMode]);

  // --------------------------------------------------------------------------
  // APP INITIALIZATION
  // --------------------------------------------------------------------------
  
  /**
   * Bootstrap application on launch
   * 
   * This effect:
   * - Requests contacts permission
   * - Requests location permission upfront (no surprise prompts later)
   * - Loads import preference
   * - Shows import modal if first run
   * - Sets up app state change listener for re-activation
   */
  useEffect(() => {
    const initializeApp = async () => {
      // Request contacts permission
      const permissionState = await Contacts.getPermissionsAsync();
      let permissionStatus = permissionState.status;
      
      if (permissionStatus !== 'granted' && 
          (permissionStatus === 'undetermined' || permissionState.canAskAgain)) {
        const requestResult = await Contacts.requestPermissionsAsync();
        permissionStatus = requestResult.status;
      }
      
      setContactPermission(permissionStatus);

      if (permissionStatus !== 'granted') {
        setShowImportModal(false);
        return;
      }

      // Request location permission upfront (better UX than surprise prompt)
      const locationPermission = await Location.getForegroundPermissionsAsync();
      if (locationPermission.status !== 'granted' && locationPermission.canAskAgain) {
        await Location.requestForegroundPermissionsAsync();
      }

      // Check if user has chosen import preference
      const savedImportChoice = await AsyncStorage.getItem(STORAGE_KEYS.IMPORT_CHOICE);
      setImportMode(savedImportChoice);
      
      if (!savedImportChoice) {
        setShowImportModal(true);
      } else {
        await fetchContactsFromDevice(false);
      }
    };

    initializeApp();
    
    // Re-initialize when app comes to foreground
    const appStateSubscription = AppState.addEventListener('change', state => {
      if (state === 'active') {
        initializeApp();
      }
    });
    
    return () => appStateSubscription.remove();
  }, [fetchContactsFromDevice]);

  // --------------------------------------------------------------------------
  // CONTACT CHANGE DETECTION
  // --------------------------------------------------------------------------
  
  /**
   * Listens for contact additions and automatically captures location
   * 
   * This effect:
   * - Subscribes to ContactsChanged event from native module
   * - Detects new contacts by comparing IDs
   * - Automatically gets current location
   * - Saves location pin for new contacts
   * - Refreshes contact list
   * 
   * Why automatic: Better UX than prompting user every time
   */
  useEffect(() => {
    if (!contactsEventEmitter) return;

    const subscription = contactsEventEmitter.addListener('ContactsChanged', async () => {
      const currentContactsResult = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.PhoneNumbers]
      });

      const currentContactIds = new Set(currentContactsResult.data.map(c => c.id));
      const previousContactIds = new Set(contacts.map(c => c.id));
      const newContactIds = [...currentContactIds].filter(id => !previousContactIds.has(id));

      if (newContactIds.length > 0) {
        // Automatically capture location for new contacts
        try {
          const { status } = await Location.getForegroundPermissionsAsync();
          
          if (status === 'granted') {
            const position = await Location.getCurrentPositionAsync({
              accuracy: Location.Accuracy.Balanced
            });

            const { latitude, longitude } = position.coords;
            const timestamp = Date.now();

            // Save location pins
            setLocationPinsByContactId(previousPins => {
              const updatedPins = { ...previousPins };
              for (const contactId of newContactIds) {
                updatedPins[contactId] = { latitude, longitude, timestamp };
              }
              saveJSON(STORAGE_KEYS.PINS, updatedPins);
              return updatedPins;
            });

            // Update first seen timestamps
            setFirstSeenTimestamps(previousTimestamps => {
              const updatedTimestamps = { ...previousTimestamps };
              for (const contactId of newContactIds) {
                if (!updatedTimestamps[contactId]) {
                  updatedTimestamps[contactId] = timestamp;
                }
              }
              saveJSON(STORAGE_KEYS.FIRST_SEEN, updatedTimestamps);
              return updatedTimestamps;
            });
          }
        } catch (error) {
          console.error('Location capture error:', error);
        }
        
        // Refresh contact list
        fetchContactsFromDevice(true);
      }
    });

    return () => subscription.remove();
  }, [contacts, fetchContactsFromDevice]);

  /**
   * Handles location events from native module
   * 
   * Why separate from ContactsChanged: Native module can also emit
   * location events with contact ID when using native add contact UI
   */
  useEffect(() => {
    if (!contactsEventEmitter) return;

    const subscription = contactsEventEmitter.addListener(
      'ContactAddedWithLocation',
      async (payload) => {
        console.log('ContactAddedWithLocation event received:', payload);
        const { id, lat, lng, timestamp } = payload || {};
        const finalTimestamp = Number.isFinite(timestamp) ? timestamp : Date.now();

        setFirstSeenTimestamps(previous => {
          const updated = { ...previous, [id]: finalTimestamp };
          saveJSON(STORAGE_KEYS.FIRST_SEEN, updated);
          return updated;
        });

        setLocationPinsByContactId(previous => {
          const updated = { 
            ...previous, 
            [id]: { latitude: lat, longitude: lng, timestamp: finalTimestamp } 
          };
          console.log('Saving pin for contact:', id, { latitude: lat, longitude: lng });
          saveJSON(STORAGE_KEYS.PINS, updated);
          return updated;
        });

        await fetchContactsFromDevice(true);
      }
    );

    return () => subscription.remove();
  }, [fetchContactsFromDevice]);

  // --------------------------------------------------------------------------
  // DATA TRANSFORMATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Filters and sorts contacts for display
   * 
   * Sorting priority:
   * 1. Contacts with timestamps (newest first)
   * 2. Contacts without timestamps (alphabetical)
   */
  const displayedContacts = useMemo(() => {
    const queryLowercase = searchQuery.trim().toLowerCase();
    
    const filteredContacts = queryLowercase
      ? contacts.filter(contact => {
          const nameMatch = (contact.name || '').toLowerCase().includes(queryLowercase);
          const tagMatch = (tagsByContactId[contact.id] || []).some(
            tag => tag.toLowerCase().includes(queryLowercase)
          );
          return nameMatch || tagMatch;
        })
      : contacts.slice();

    // Sort by creation time (most recent first)
    filteredContacts.sort((contactA, contactB) => {
      const timeA = getContactCreationTime(contactA);
      const timeB = getContactCreationTime(contactB);
      const hasTimeA = timeA > 0;
      const hasTimeB = timeB > 0;
      
      if (hasTimeA && hasTimeB) return timeB - timeA; // Both have times: newer first
      if (hasTimeA && !hasTimeB) return -1;           // Only A has time: A first
      if (!hasTimeA && hasTimeB) return 1;            // Only B has time: B first
      
      // Neither has time: alphabetical
      return (contactA.name || '').localeCompare(contactB.name || '');
    });

    return filteredContacts;
  }, [contacts, searchQuery, tagsByContactId, getContactCreationTime]);

  /**
   * Filters contacts to only those with location pins
   */
  const contactsWithLocationPins = useMemo(() => {
    return displayedContacts.filter(contact => locationPinsByContactId[contact.id]);
  }, [displayedContacts, locationPinsByContactId]);

  /**
   * Calculates map region to fit all pins
   * 
   * Algorithm:
   * 1. Find min/max latitude and longitude
   * 2. Center on midpoint
   * 3. Set delta to encompass all pins with 1.5x padding
   */
  const calculatedMapRegion = useMemo(() => {
    if (contactsWithLocationPins.length === 0) {
      // Default to Denver, CO area if no pins
      return {
        latitude: 39.7392,
        longitude: -104.9903,
        latitudeDelta: 0.5,
        longitudeDelta: 0.5,
      };
    }

    const latitudes = contactsWithLocationPins.map(c => locationPinsByContactId[c.id].latitude);
    const longitudes = contactsWithLocationPins.map(c => locationPinsByContactId[c.id].longitude);

    const minLatitude = Math.min(...latitudes);
    const maxLatitude = Math.max(...latitudes);
    const minLongitude = Math.min(...longitudes);
    const maxLongitude = Math.max(...longitudes);

    return {
      latitude: (minLatitude + maxLatitude) / 2,
      longitude: (minLongitude + maxLongitude) / 2,
      latitudeDelta: Math.max(maxLatitude - minLatitude, 0.05) * 1.5,
      longitudeDelta: Math.max(maxLongitude - minLongitude, 0.05) * 1.5,
    };
  }, [contactsWithLocationPins, locationPinsByContactId]);

  // --------------------------------------------------------------------------
  // RENDER: PERMISSION GATE
  // --------------------------------------------------------------------------
  
  if (contactPermission !== 'granted') {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.title}>NeverForget</Text>
        <Text style={{ textAlign: 'center', marginTop: 8 }}>
          This app needs access to your contacts to function.
        </Text>
        <TouchableOpacity 
          style={styles.callToAction} 
          onPress={() => Linking.openSettings()}
        >
          <Text style={styles.callToActionText}>Open Settings</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // --------------------------------------------------------------------------
  // RENDER: MAIN UI
  // --------------------------------------------------------------------------
  
  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>NeverForget</Text>

      {/* Search Bar */}
      <TextInput
        value={searchQuery}
        onChangeText={setSearchQuery}
        placeholder="Search name or tag…"
        autoCapitalize="none"
        style={styles.searchInput}
      />

      {/* View Tabs */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          onPress={() => setCurrentView('list')}
          style={[styles.tab, currentView === 'list' && styles.tabActive]}
        >
          <Text style={[styles.tabText, currentView === 'list' && styles.tabTextActive]}>
            Created
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setCurrentView('map')}
          style={[styles.tab, currentView === 'map' && styles.tabActive]}
        >
          <Text style={[styles.tabText, currentView === 'map' && styles.tabTextActive]}>
            Map
          </Text>
        </TouchableOpacity>
      </View>

      {/* Loading Indicator */}
      {isLoadingContacts ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator />
          <Text style={{ marginTop: 6 }}>Loading contacts…</Text>
        </View>
        
      ) : currentView === 'map' ? (
        // Map View
        <View style={styles.mapContainer}>
          {contactsWithLocationPins.length === 0 ? (
            <View style={styles.emptyMapState}>
              <Text style={styles.emptyText}>No contacts with location data</Text>
              <Text style={styles.emptyHint}>
                Add a contact to see where you met them
              </Text>
            </View>
          ) : (
            <MapView
              style={styles.map}
              initialRegion={calculatedMapRegion}
              showsUserLocation
              showsMyLocationButton
            >
              {contactsWithLocationPins.map((contact) => {
                const pin = locationPinsByContactId[contact.id];
                const tags = tagsByContactId[contact.id] || [];
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
                    onCalloutPress={() => openLocationInNativeMaps(pin, contact.name || 'Contact')}
                  />
                );
              })}
            </MapView>
          )}
        </View>
        
      ) : (
        // List View
        <FlatList
          data={displayedContacts}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl 
              refreshing={isRefreshing} 
              onRefresh={() => fetchContactsFromDevice(true)} 
            />
          }
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={<Text style={styles.emptyText}>No contacts</Text>}
          renderItem={({ item: contact }) => {
            const creationTime = getContactCreationTime(contact);
            const tags = tagsByContactId[contact.id] || [];
            const locationPin = locationPinsByContactId[contact.id];

            return (
              <View style={styles.contactRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.contactName}>
                    {contact.name || '(No name)'}
                  </Text>
                  
                  {!!contact.phoneNumbers?.length && (
                    <Text style={styles.contactSubtext}>
                      {contact.phoneNumbers[0]?.number}
                    </Text>
                  )}

                  {/* Tags Row */}
                  <View style={styles.tagsRow}>
                    {tags.map((tag) => (
                      <TouchableOpacity
                        key={tag}
                        onLongPress={() => removeTagFromContact(contact.id, tag)}
                        style={styles.tagChip}
                      >
                        <Text style={styles.tagText}>{tag}</Text>
                      </TouchableOpacity>
                    ))}
                    
                    {/* Tag Editor */}
                    {contactBeingTagged === contact.id ? (
                      <View style={styles.tagEditor}>
                        <TextInput
                          style={styles.tagInput}
                          placeholder="Add tag"
                          value={tagInputText}
                          onChangeText={setTagInputText}
                          onSubmitEditing={async () => {
                            await addTagToContact(contact.id, tagInputText);
                            setTagInputText('');
                            setContactBeingTagged(null);
                          }}
                          autoCapitalize="none"
                        />
                        <TouchableOpacity
                          onPress={async () => {
                            await addTagToContact(contact.id, tagInputText);
                            setTagInputText('');
                            setContactBeingTagged(null);
                          }}
                          style={styles.tagSaveButton}
                        >
                          <Text style={styles.tagSaveButtonText}>Add</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => {
                            setTagInputText('');
                            setContactBeingTagged(null);
                          }}
                        >
                          <Text style={styles.tagCancelText}>Cancel</Text>
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <TouchableOpacity
                        onPress={() => setContactBeingTagged(contact.id)}
                        style={styles.tagAddButton}
                      >
                        <Text style={styles.tagAddButtonText}>+ Tag</Text>
                      </TouchableOpacity>
                    )}

                    {/* Map Button */}
                    {locationPin && (
                      <TouchableOpacity
                        onPress={() => openLocationInNativeMaps(locationPin, contact.name || 'Contact')}
                        style={styles.mapButton}
                      >
                        <Text style={styles.mapButtonText}>Open in Maps</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>

                {/* Timestamp Badge */}
                <Text style={styles.timestampBadge}>
                  {creationTime ? formatAbsoluteTime(creationTime) : ''}
                </Text>
              </View>
            );
          }}
        />
      )}

      {/* Import Mode Selection Modal */}
      <Modal transparent visible={showImportModal} animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>How should we start?</Text>
            <Text style={styles.modalParagraph}>
              • <Text style={{ fontWeight: '600' }}>Import existing</Text>: show all your current contacts now.
            </Text>
            <Text style={styles.modalParagraph}>
              • <Text style={{ fontWeight: '600' }}>Only new</Text>: only track contacts you add from now on.
            </Text>
            <View style={{ height: 12 }} />
            
            <TouchableOpacity
              style={styles.callToAction}
              onPress={async () => {
                await AsyncStorage.setItem(STORAGE_KEYS.IMPORT_CHOICE, 'all');
                setImportMode('all');
                setShowImportModal(false);
                await fetchContactsFromDevice(false);
              }}
            >
              <Text style={styles.callToActionText}>Import existing</Text>
            </TouchableOpacity>
            
            <TouchableOpacity
              style={[styles.callToAction, { backgroundColor: '#444' }]}
              onPress={async () => {
                const cutoffTime = Date.now();
                console.log('User chose newOnly, setting cutoff:', cutoffTime);
                await AsyncStorage.setItem(STORAGE_KEYS.IMPORT_CHOICE, 'newOnly');
                await AsyncStorage.setItem(STORAGE_KEYS.READY, cutoffTime.toString());
                
                // Mark all existing contacts as seen with cutoff time
                const firstSeenMap = await loadJSON(STORAGE_KEYS.FIRST_SEEN, {});
                const allContacts = await Contacts.getContactsAsync({ 
                  fields: [Contacts.Fields.PhoneNumbers] 
                });
                
                for (const contact of allContacts.data) {
                  firstSeenMap[contact.id] = cutoffTime;
                }
                await saveJSON(STORAGE_KEYS.FIRST_SEEN, firstSeenMap);
                
                setImportMode('newOnly');
                setShowImportModal(false);
                await fetchContactsFromDevice(false);
              }}
            >
              <Text style={styles.callToActionText}>Only new going forward</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ============================================================================
// STYLES
// ============================================================================

const styles = {
  container: { 
    flex: 1, 
    backgroundColor: '#fff', 
    paddingHorizontal: 16 
  },
  center: { 
    flex: 1, 
    alignItems: 'center', 
    justifyContent: 'center' 
  },
  title: { 
    fontSize: 28, 
    fontWeight: '800', 
    marginTop: 8, 
    marginBottom: 10 
  },
  searchInput: { 
    borderWidth: 1, 
    borderColor: '#ddd', 
    borderRadius: 10, 
    paddingHorizontal: 12, 
    paddingVertical: 8, 
    marginBottom: 10 
  },
  tabBar: { 
    flexDirection: 'row', 
    gap: 8, 
    marginBottom: 8 
  },
  tab: { 
    paddingVertical: 6, 
    paddingHorizontal: 12, 
    borderRadius: 8, 
    backgroundColor: '#eee' 
  },
  tabActive: { 
    backgroundColor: '#111' 
  },
  tabText: { 
    fontWeight: '700', 
    color: '#111', 
    fontSize: 14 
  },
  tabTextActive: { 
    color: '#fff' 
  },
  loadingContainer: { 
    alignItems: 'center', 
    marginTop: 40 
  },
  separator: { 
    height: 1, 
    backgroundColor: '#eee' 
  },
  emptyText: { 
    textAlign: 'center', 
    marginTop: 32, 
    color: '#666', 
    fontSize: 16 
  },
  emptyHint: { 
    textAlign: 'center', 
    marginTop: 8, 
    color: '#999', 
    fontSize: 14 
  },
  contactRow: { 
    flexDirection: 'row', 
    paddingVertical: 10, 
    gap: 10 
  },
  contactName: { 
    fontSize: 16, 
    fontWeight: '700' 
  },
  contactSubtext: { 
    color: '#666', 
    marginTop: 2, 
    fontSize: 14 
  },
  timestampBadge: { 
    alignSelf: 'flex-start', 
    color: '#666', 
    fontSize: 12 
  },
  tagsRow: { 
    flexDirection: 'row', 
    flexWrap: 'wrap', 
    gap: 8, 
    marginTop: 8, 
    alignItems: 'center' 
  },
  tagChip: { 
    backgroundColor: '#f0f0f0', 
    borderRadius: 999, 
    paddingHorizontal: 10, 
    paddingVertical: 4 
  },
  tagText: { 
    fontWeight: '600', 
    color: '#333', 
    fontSize: 12 
  },
  tagAddButton: { 
    paddingHorizontal: 10, 
    paddingVertical: 4, 
    borderRadius: 999, 
    backgroundColor: '#e8f0ff' 
  },
  tagAddButtonText: { 
    fontWeight: '700', 
    color: '#3366ff', 
    fontSize: 12 
  },
  mapButton: { 
    paddingHorizontal: 10, 
    paddingVertical: 4, 
    borderRadius: 999, 
    backgroundColor: '#e8f0ff' 
  },
  mapButtonText: { 
    fontWeight: '700', 
    color: '#3366ff', 
    fontSize: 12 
  },
  tagEditor: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    gap: 8 
  },
  tagInput: { 
    borderWidth: 1, 
    borderColor: '#ddd', 
    borderRadius: 8, 
    paddingHorizontal: 10, 
    paddingVertical: 6, 
    minWidth: 120, 
    fontSize: 14 
  },
  tagSaveButton: { 
    backgroundColor: '#111', 
    borderRadius: 8, 
    paddingHorizontal: 12, 
    paddingVertical: 6 
  },
  tagSaveButtonText: { 
    color: '#fff', 
    fontWeight: '700', 
    fontSize: 12 
  },
  tagCancelText: { 
    color: '#666', 
    fontSize: 12 
  },
  mapContainer: { 
    flex: 1, 
    borderRadius: 12, 
    overflow: 'hidden', 
    marginTop: 8 
  },
  map: { 
    flex: 1 
  },
  emptyMapState: { 
    flex: 1, 
    alignItems: 'center', 
    justifyContent: 'center', 
    backgroundColor: '#f9f9f9' 
  },
  modalBackdrop: { 
    flex: 1, 
    backgroundColor: 'rgba(0,0,0,0.35)', 
    alignItems: 'center', 
    justifyContent: 'center' 
  },
  modalCard: { 
    width: '86%', 
    backgroundColor: '#fff', 
    borderRadius: 16, 
    padding: 18 
  },
  modalTitle: { 
    fontSize: 18, 
    fontWeight: '800', 
    marginBottom: 8 
  },
  modalParagraph: { 
    color: '#333', 
    marginTop: 4, 
    fontSize: 14 
  },
  callToAction: { 
    backgroundColor: '#111', 
    paddingVertical: 10, 
    borderRadius: 10, 
    marginTop: 10, 
    alignItems: 'center' 
  },
  callToActionText: { 
    color: '#fff', 
    fontWeight: '800', 
    fontSize: 16 
  },
};