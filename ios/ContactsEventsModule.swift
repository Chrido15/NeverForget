/**
 * ContactsEventsModule.swift
 * NeverForget
 *
 * Purpose: Native iOS module that provides real-time contact change notifications
 *          and location capture when contacts are added.
 *
 * Author: Bryce Christian
 * Course: SENG 564
 * Date: November 16, 2025
 *
 * Clean Code Principles Applied:
 * - Single Responsibility: Each method does one thing
 * - Meaningful names: Methods named after what they do
 * - Small functions: No function over 20 lines
 * - Comments explain "why", not "what"
 * - Error handling with guard statements
 */

import Foundation
import Contacts
import ContactsUI
import CoreLocation
import React

// MARK: - Module Definition

/**
 * React Native event emitter for contact-related events
 *
 * This module bridges iOS contact and location APIs to React Native,
 * enabling automatic location capture when contacts are added.
 *
 * Events emitted:
 * - ContactsChanged: When device contact store changes
 * - ContactAddedWithLocation: When a contact is added with GPS coordinates
 */
@objc(ContactsEventsModule)
class ContactsEventsModule: RCTEventEmitter, CLLocationManagerDelegate, CNContactViewControllerDelegate {

  // MARK: - Properties
  
  /// Tracks whether JavaScript has active listeners
  private var hasListeners = false
  
  /// Manages GPS location requests
  private var locationManager: CLLocationManager?
  
  /// Temporarily stores contact ID while waiting for location
  private var pendingContactId: String?

  // MARK: - Module Configuration
  
  /**
   * Specifies that this module requires main queue setup
   *
   * Why: RCTEventEmitter must be initialized on main thread to properly
   *      send events to JavaScript bridge.
   */
  override static func requiresMainQueueSetup() -> Bool { 
    return true
  }

  /**
   * Declares events that this module can emit
   *
   * Why: React Native requires explicit declaration of events for type safety
   *      and proper bridge initialization.
   */
  override func supportedEvents() -> [String]! {
    return ["ContactsChanged", "ContactAddedWithLocation"]
  }

  // MARK: - Listener Lifecycle
  
  /**
   * Called when JavaScript adds first event listener
   *
   * Registers for system contact store change notifications.
   * Only subscribes if we have active listeners for performance.
   */
  override func startObserving() {
    hasListeners = true
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleContactStoreDidChange),
      name: .CNContactStoreDidChange,
      object: nil
    )
  }

  /**
   * Called when JavaScript removes all event listeners
   *
   * Unregisters from system notifications to prevent memory leaks
   * and unnecessary CPU usage.
   */
  override func stopObserving() {
    hasListeners = false
    NotificationCenter.default.removeObserver(
      self, 
      name: .CNContactStoreDidChange, 
      object: nil
    )
  }

  /**
   * Handles system contact store change notification
   *
   * Why separate from NotificationCenter: Guard clause prevents sending
   *      events when no JavaScript listeners exist.
   */
  @objc private func handleContactStoreDidChange() {
    guard hasListeners else { return }
    sendEvent(withName: "ContactsChanged", body: [:])
  }

  // MARK: - Exported Methods (Callable from JavaScript)
  
  /**
   * Opens native iOS contact creation UI
   *
   * Exported to JavaScript as: ContactsEventsModule.openAddContact()
   *
   * Why this exists: Allows JavaScript to trigger native contact UI,
   *                  which automatically hooks into our delegate methods
   *                  for location capture.
   */
  @objc(openAddContact)
  func openAddContact() {
    DispatchQueue.main.async {
      let contactViewController = CNContactViewController(forNewContact: nil)
      contactViewController.delegate = self
      
      let navigationController = UINavigationController(
        rootViewController: contactViewController
      )
      navigationController.modalPresentationStyle = .formSheet
      
      // Present on top of current view controller
      if let presentedController = RCTPresentedViewController() {
        presentedController.present(navigationController, animated: true, completion: nil)
      }
    }
  }

  // MARK: - CNContactViewControllerDelegate
  
  /**
   * Called when user finishes adding/editing contact
   *
   * Flow:
   * 1. User clicks "Done" in native contact UI
   * 2. This method fires
   * 3. We dismiss the UI
   * 4. We request location permission if needed
   * 5. We start location manager to get GPS coordinates
   *
   * Why here: This is the perfect time to capture location - right when
   *           we know a contact was just added.
   */
  func contactViewController(
    _ viewController: CNContactViewController, 
    didCompleteWith contact: CNContact?
  ) {
    viewController.dismiss(animated: true, completion: nil)
    
    // User cancelled - no contact to process
    guard let contact = contact else { return }

    // Store contact ID to associate with location later
    pendingContactId = contact.identifier

    // Initialize location manager with battery-optimized settings
    locationManager = CLLocationManager()
    locationManager?.delegate = self
    locationManager?.desiredAccuracy = kCLLocationAccuracyHundredMeters // Balanced accuracy

    // Request location permission if not already granted
    let authorizationStatus = CLLocationManager.authorizationStatus()
    
    if authorizationStatus == .notDetermined {
      locationManager?.requestWhenInUseAuthorization()
    } else if authorizationStatus == .authorizedWhenInUse || 
              authorizationStatus == .authorizedAlways {
      locationManager?.startUpdatingLocation()
    }
  }

  // MARK: - CLLocationManagerDelegate
  
  /**
   * Called when location authorization status changes
   *
   * Why: User might deny permission initially, then grant it in Settings.
   *      This ensures we start location updates when permission is granted.
   */
  func locationManager(
    _ manager: CLLocationManager, 
    didChangeAuthorization status: CLAuthorizationStatus
  ) {
    if status == .authorizedWhenInUse || status == .authorizedAlways {
      manager.startUpdatingLocation()
    }
  }

  /**
   * Called when GPS coordinates are acquired
   *
   * Flow:
   * 1. Receive location update from iOS
   * 2. Stop location manager (battery optimization)
   * 3. Extract coordinates
   * 4. Send event to JavaScript with contact ID + location
   * 5. Clear pending contact ID
   *
   * Why stop immediately: We only need one location reading per contact.
   *                       Continuous updates would drain battery.
   */
  func locationManager(
    _ manager: CLLocationManager, 
    didUpdateLocations locations: [CLLocation]
  ) {
    manager.stopUpdatingLocation()
    
    // Ensure we have listeners, a pending contact, and valid coordinates
    guard hasListeners,
          let contactId = pendingContactId,
          let coordinate = locations.last?.coordinate else {
      pendingContactId = nil
      return
    }
    
    // Clear pending contact before sending event
    pendingContactId = nil
    
    // Convert to milliseconds for JavaScript compatibility
    let timestampMilliseconds = Int(Date().timeIntervalSince1970 * 1000)

    // Send event to JavaScript
    sendEvent(
      withName: "ContactAddedWithLocation",
      body: [
        "id": contactId, 
        "lat": coordinate.latitude, 
        "lng": coordinate.longitude, 
        "timestamp": timestampMilliseconds
      ]
    )
  }

  /**
   * Called when location acquisition fails
   *
   * Reasons for failure:
   * - User denied location permission
   * - GPS signal unavailable (indoors, poor signal)
   * - Timeout
   *
   * Why not retry: Better UX to fail gracefully than block user.
   *                Contact is still saved, just without location.
   */
  func locationManager(
    _ manager: CLLocationManager, 
    didFailWithError error: Error
  ) {
    print("Location error: \(error)")
    pendingContactId = nil
    manager.stopUpdatingLocation()
  }
}

// MARK: - Design Notes
//
// This module uses the Delegate pattern (iOS standard) to handle async events
// from both Contacts and CoreLocation frameworks.
//
// Memory Management:
// - Observers are removed in stopObserving() to prevent leaks
// - Location manager is stopped after each reading
// - Pending contact ID is always cleared to prevent stale references
//
// Thread Safety:
// - Main queue setup ensures UI operations are on main thread
// - Location callbacks happen on arbitrary threads but are safe
//   because we only access local variables
//
// Error Handling:
// - Guard clauses for defensive programming
// - Graceful degradation (contact saved without location on error)
// - Logging for debugging but no user-facing errors