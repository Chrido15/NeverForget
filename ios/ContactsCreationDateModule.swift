//
//  ContactsCreationDateModule.swift
//  NeverForget
//
//  Created by Bryce Christian  on 11/16/25.
//

import Foundation
import Contacts

@objc(ContactsCreationDateModule)
class ContactsCreationDateModule: NSObject {}

extension ContactsCreationDateModule: RCTBridgeModule {
  static func moduleName() -> String! { "ContactsCreationDateModule" }
  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc(getPhoneDates:rejecter:)
  func getPhoneDates(resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {

    // Use CNContactStore (modern API) - no separate permission needed if already granted via Expo
    let store = CNContactStore()
    
    // Check if we already have permission (granted via Expo Contacts)
    let authStatus = CNContactStore.authorizationStatus(for: .contacts)
    
    if authStatus == .denied || authStatus == .restricted {
      reject("PERM_DENIED", "Contacts permission denied", nil)
      return
    }
    
    if authStatus == .notDetermined {
      // Should not happen if Expo already requested, but handle it
      store.requestAccess(for: .contacts) { granted, error in
        if !granted {
          reject("PERM_DENIED", "Contacts permission denied", error)
          return
        }
        self.fetchContactDates(store: store, resolve: resolve, reject: reject)
      }
    } else {
      // Already authorized
      fetchContactDates(store: store, resolve: resolve, reject: reject)
    }
  }
  
  private func fetchContactDates(store: CNContactStore,
                                  resolve: @escaping RCTPromiseResolveBlock,
                                  reject: @escaping RCTPromiseRejectBlock) {
    let keys = [CNContactPhoneNumbersKey, CNContactIdentifierKey] as [CNKeyDescriptor]
    let request = CNContactFetchRequest(keysToFetch: keys)
    
    var phoneToDate: [String: Date] = [:]
    
    do {
      try store.enumerateContacts(with: request) { contact, _ in
        // CNContact doesn't expose creation date directly
        // We'll return empty for now since AddressBook is deprecated
        // The app will fall back to firstSeen timestamps
        for phone in contact.phoneNumbers {
          let digits = phone.value.stringValue.filter { "0123456789".contains($0) }
          if !digits.isEmpty && phoneToDate[digits] == nil {
            // No creation date available from CNContacts API
            // Return null and let JavaScript use firstSeen
            phoneToDate[digits] = nil
          }
        }
      }
      
      // Return empty array since we can't get creation dates from CNContacts
      // App will use firstSeen timestamps instead
      resolve([])
      
    } catch {
      reject("FETCH_ERROR", "Failed to fetch contacts", error)
    }
  }
}
