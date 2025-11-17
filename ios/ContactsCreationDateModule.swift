/**
 * ContactsCreationDateModule.swift
 * NeverForget
 *
 * Purpose: Native iOS module that retrieves contact creation and modification dates
 *          from the deprecated AddressBook framework.
 *
 * Author: Bryce Christian
 * Course: SENG 564
 * Date: November 16, 2025
 *
 * Why AddressBook:
 * The modern CNContacts API does not expose contact creation dates. However,
 * the deprecated AddressBook framework still provides this metadata. This module
 * uses AddressBook temporarily to access creation dates while still requesting
 * permission through the modern CNContacts API for better UX.
 *
 * Clean Code Principles Applied:
 * - Intention-revealing names
 * - Small, focused functions
 * - Error handling with early returns
 * - Comments explain "why", not "what"
 * - No magic numbers or strings
 */

import Foundation
import Contacts
import AddressBook

// MARK: - Module Definition

/**
 * React Native bridge module for contact metadata retrieval
 *
 * This module provides a single method that returns an array of phone numbers
 * with their associated creation and modification timestamps.
 */
@objc(ContactsCreationDateModule)
class ContactsCreationDateModule: NSObject {}

// MARK: - Bridge Protocol Conformance

extension ContactsCreationDateModule: RCTBridgeModule {
  
  /**
   * Module name exposed to JavaScript
   *
   * JavaScript will access this as: ContactsCreationDateModule.getPhoneDates()
   */
  static func moduleName() -> String! { 
    return "ContactsCreationDateModule" 
  }
  
  /**
   * Specifies that this module does NOT require main queue setup
   *
   * Why false: This module only does data fetching with no UI operations.
   *            Running on background queue improves performance.
   */
  @objc static func requiresMainQueueSetup() -> Bool { 
    return false 
  }

  // MARK: - Exported Methods
  
  /**
   * Fetches creation and modification dates for all contacts
   *
   * Returns: Array of objects with structure:
   * [{
   *   phone: "13035551212",           // Digits only
   *   creationDate: "2021-03-10T18:14:22Z" | null,
   *   modificationDate: "2025-09-05T04:12:00Z" | null
   * }]
   *
   * Why this structure: Phone numbers are the only unique identifier available
   *                     from AddressBook that also exists in CNContacts.
   *
   * Algorithm:
   * 1. Request permission via CNContacts (modern API for better UX)
   * 2. Access AddressBook (deprecated but still functional)
   * 3. Iterate all contacts
   * 4. For each phone number, track earliest creation and latest modification
   * 5. Return aggregated data
   *
   * Why aggregate: A single phone number might appear in multiple contacts
   *                (linked contacts). We want the earliest creation date.
   */
  @objc(getPhoneDates:rejecter:)
  func getPhoneDates(
    resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    // Step 1: Request permission through modern CNContacts API
    CNContactStore().requestAccess(for: .contacts) { granted, error in
      if let error = error { 
        reject("PERM_ERR", "Contacts permission error", error)
        return 
      }
      if !granted { 
        reject("PERM_DENIED", "Contacts permission denied", nil)
        return 
      }

      // Step 2: Create AddressBook instance
      var addressBookError: Unmanaged<CFError>?
      guard let addressBook = ABAddressBookCreateWithOptions(nil, &addressBookError)?
              .takeRetainedValue() else {
        reject(
          "AB_CREATE_ERR", 
          "Unable to create AddressBook", 
          addressBookError?.takeRetainedValue()
        )
        return
      }

      // Step 3: Request AddressBook permission (separate from Contacts)
      //
      // Why separate: AddressBook is deprecated but still requires its own
      //               permission flow. We've already granted CNContacts above,
      //               so this typically succeeds immediately.
      ABAddressBookRequestAccessWithCompletion(addressBook) { accessGranted, accessError in
        if let accessError = accessError { 
          reject("AB_PERM_ERR", "AddressBook permission error", accessError)
          return 
        }
        if !accessGranted { 
          reject("AB_DENIED", "AddressBook permission denied", nil)
          return 
        }

        // Step 4: Retrieve all contacts from AddressBook
        guard let allPeople = ABAddressBookCopyArrayOfAllPeople(addressBook)?
                .takeRetainedValue() as? [ABRecord] else { 
          // No contacts - return empty array rather than error
          resolve([])
          return 
        }

        // Step 5: Build aggregated phone number metadata
        //
        // Data structures:
        // - earliestCreation: phone -> earliest creation date across contacts
        // - latestModification: phone -> latest modification date across contacts
        //
        // Why separate dictionaries: A phone might have creation date but no
        //                            modification date, or vice versa.
        var earliestCreation: [String: Date] = [:]
        var latestModification: [String: Date] = [:]

        for person in allPeople {
          // Extract timestamps for this contact
          let creationDate = ABRecordCopyValue(person, kABPersonCreationDateProperty)?
            .takeRetainedValue() as? Date
          let modificationDate = ABRecordCopyValue(person, kABPersonModificationDateProperty)?
            .takeRetainedValue() as? Date

          // Get all phone numbers for this contact
          guard let phoneNumbersMultiValue = ABRecordCopyValue(person, kABPersonPhoneProperty)?
                  .takeRetainedValue() as? ABMultiValue else { 
            continue 
          }

          let phoneCount = ABMultiValueGetCount(phoneNumbersMultiValue)
          
          for index in 0..<phoneCount {
            guard let phoneNumberString = ABMultiValueCopyValueAtIndex(
                    phoneNumbersMultiValue, 
                    index
                  )?.takeRetainedValue() as? String else {
              continue
            }

            // Normalize phone number to digits only for consistent lookups
            let digitsOnly = phoneNumberString.filter { "0123456789".contains($0) }
            if digitsOnly.isEmpty { continue }

            // Update earliest creation date for this phone number
            if let creation = creationDate {
              if let existingCreation = earliestCreation[digitsOnly] {
                if creation < existingCreation {
                  earliestCreation[digitsOnly] = creation
                }
              } else {
                earliestCreation[digitsOnly] = creation
              }
            }

            // Update latest modification date for this phone number
            if let modification = modificationDate {
              if let existingModification = latestModification[digitsOnly] {
                if modification > existingModification {
                  latestModification[digitsOnly] = modification
                }
              } else {
                latestModification[digitsOnly] = modification
              }
            }
          }
        }

        // Step 6: Build output array
        //
        // Format dates as ISO 8601 strings for JSON serialization
        let dateFormatter = ISO8601DateFormatter()
        var outputArray: [[String: Any]] = []
        
        // Get union of all phone numbers from both dictionaries
        let allPhoneNumbers = Set(earliestCreation.keys).union(latestModification.keys)
        
        for phoneNumber in allPhoneNumbers {
          var row: [String: Any] = ["phone": phoneNumber]
          
          // Add creation date or null
          if let creation = earliestCreation[phoneNumber] {
            row["creationDate"] = dateFormatter.string(from: creation)
          } else {
            row["creationDate"] = NSNull()
          }
          
          // Add modification date or null
          if let modification = latestModification[phoneNumber] {
            row["modificationDate"] = dateFormatter.string(from: modification)
          } else {
            row["modificationDate"] = NSNull()
          }
          
          outputArray.append(row)
        }

        // Step 7: Return to JavaScript
        resolve(outputArray)
      }
    }
  }
}

// MARK: - Design Notes
//
// Deprecated API Usage:
// This module uses AddressBook which Apple deprecated in iOS 9 (2015).
// However, it still functions as of iOS 18 and provides the only way to
// access contact creation dates. This is acceptable for an MVP but should
// be revisited if Apple removes AddressBook in a future iOS version.
//
// Alternative Approach:
// If AddressBook is removed, we could:
// 1. Fall back entirely to firstSeen timestamps
// 2. Use iCloud sync metadata (if available)
// 3. Parse vCard files directly (complex)
//
// Memory Management:
// All Core Foundation objects are properly released via takeRetainedValue()
// to prevent memory leaks. This is critical with deprecated APIs that use
// manual reference counting.
//
// Error Handling Philosophy:
// - Early returns with reject() for permission errors
// - Empty array return for "no contacts" (not an error state)
// - Defensive programming with guard statements
// - No force unwrapping (all optionals safely handled)
//
// Performance Considerations:
// - O(n * m) complexity where n = contacts, m = avg phones per contact
// - For 1000 contacts with 2 phones each: ~2000 iterations
// - Hash map lookups are O(1), so overall performance is acceptable
// - Runs on background queue (requiresMainQueueSetup = false)