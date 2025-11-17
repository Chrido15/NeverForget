//
//  ContactsCreationDateModule.swift
//  NeverForget
//
//  Created by Bryce Christian  on 11/16/25.
//

import Foundation
import Contacts
import AddressBook
import React

@objc(ContactsCreationDateModule)
class ContactsCreationDateModule: NSObject {}

extension ContactsCreationDateModule: RCTBridgeModule {
  static func moduleName() -> String! { "ContactsCreationDateModule" }
  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc(getPhoneDates:rejecter:)
  func getPhoneDates(resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {

    CNContactStore().requestAccess(for: .contacts) { granted, err in
      if let err = err { reject("PERM_ERR", "Contacts permission error", err); return }
      if !granted { reject("PERM_DENIED", "Contacts permission denied", nil); return }

      var cfErr: Unmanaged<CFError>?
      guard let ab = ABAddressBookCreateWithOptions(nil, &cfErr)?.takeRetainedValue() else {
        reject("AB_CREATE_ERR", "Unable to create AddressBook", cfErr?.takeRetainedValue()); return
      }

      ABAddressBookRequestAccessWithCompletion(ab) { ok, abErr in
        if let abErr = abErr { reject("AB_PERM_ERR", "AddressBook permission error", abErr); return }
        if !ok { reject("AB_DENIED", "AddressBook permission denied", nil); return }

        guard let people = ABAddressBookCopyArrayOfAllPeople(ab)?
                .takeRetainedValue() as? [ABRecord] else { resolve([]); return }

        var earliestCreation: [String: Date] = [:]
        var latestModification: [String: Date] = [:]

        for person in people {
          let created  = ABRecordCopyValue(person, kABPersonCreationDateProperty)?.takeRetainedValue() as? Date
          let modified = ABRecordCopyValue(person, kABPersonModificationDateProperty)?.takeRetainedValue() as? Date

          guard let multi = ABRecordCopyValue(person, kABPersonPhoneProperty)?
                  .takeRetainedValue() as? ABMultiValue else { continue }

          let count = ABMultiValueGetCount(multi)
          for i in 0..<count {
            if let val = ABMultiValueCopyValueAtIndex(multi, i)?.takeRetainedValue() as? String {
              let digits = val.filter { "0123456789".contains($0) }
              if digits.isEmpty { continue }

              if let c = created {
                if let existing = earliestCreation[digits] {
                  if c < existing { earliestCreation[digits] = c }
                } else {
                  earliestCreation[digits] = c
                }
              }
              if let m = modified {
                if let existing = latestModification[digits] {
                  if m > existing { latestModification[digits] = m }
                } else {
                  latestModification[digits] = m
                }
              }
            }
          }
        }

        let fmt = ISO8601DateFormatter()
        var out: [[String: Any]] = []
        let allPhones = Set(earliestCreation.keys).union(latestModification.keys)
        for p in allPhones {
          var row: [String: Any] = ["phone": p]
          if let c = earliestCreation[p] { row["creationDate"] = fmt.string(from: c) } else { row["creationDate"] = NSNull() }
          if let m = latestModification[p] { row["modificationDate"] = fmt.string(from: m) } else { row["modificationDate"] = NSNull() }
          out.append(row)
        }

        resolve(out)
      }
    }
  }
}
