import Foundation
import Contacts
import ContactsUI
import CoreLocation
import React

@objc(ContactsEventsModule)
class ContactsEventsModule: RCTEventEmitter, CLLocationManagerDelegate, CNContactViewControllerDelegate {

  private var hasListeners = false
  private var locationManager: CLLocationManager?
  private var pendingContactId: String?

  // *** CRITICAL: Main queue setup is required for RCTEventEmitter ***
  override static func requiresMainQueueSetup() -> Bool { 
    return true  // Changed from 'true' to ensure proper initialization
  }

  // *** MUST advertise BOTH events here ***
  override func supportedEvents() -> [String]! {
    return ["ContactsChanged", "ContactAddedWithLocation"]
  }

  // Listener lifecycle
  override func startObserving() {
    hasListeners = true
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(onStoreDidChange),
      name: .CNContactStoreDidChange,
      object: nil
    )
  }

  override func stopObserving() {
    hasListeners = false
    NotificationCenter.default.removeObserver(self, name: .CNContactStoreDidChange, object: nil)
  }

  @objc private func onStoreDidChange() {
    guard hasListeners else { return }
    sendEvent(withName: "ContactsChanged", body: [:])
  }

  // ***** METHOD EXPOSED TO JS *****
  @objc(openAddContact)
  func openAddContact() {
    DispatchQueue.main.async {
      let vc = CNContactViewController(forNewContact: nil)
      vc.delegate = self
      let nav = UINavigationController(rootViewController: vc)
      nav.modalPresentationStyle = .formSheet
      
      // Use RCTPresentedViewController() to get the current view controller
      if let presented = RCTPresentedViewController() {
        presented.present(nav, animated: true, completion: nil)
      }
    }
  }

  // CNContactViewControllerDelegate
  func contactViewController(_ viewController: CNContactViewController, didCompleteWith contact: CNContact?) {
    viewController.dismiss(animated: true, completion: nil)
    guard let contact = contact else { return } // user cancelled

    pendingContactId = contact.identifier

    // Request location
    locationManager = CLLocationManager()
    locationManager?.delegate = self
    locationManager?.desiredAccuracy = kCLLocationAccuracyHundredMeters

    let status = CLLocationManager.authorizationStatus()
    if status == .notDetermined {
      locationManager?.requestWhenInUseAuthorization()
    } else if status == .authorizedWhenInUse || status == .authorizedAlways {
      locationManager?.startUpdatingLocation()
    }
  }

  // CLLocationManagerDelegate
  func locationManager(_ manager: CLLocationManager, didChangeAuthorization status: CLAuthorizationStatus) {
    if status == .authorizedWhenInUse || status == .authorizedAlways {
      manager.startUpdatingLocation()
    }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    manager.stopUpdatingLocation()
    
    guard hasListeners, 
          let id = pendingContactId, 
          let coord = locations.last?.coordinate else {
      pendingContactId = nil
      return
    }
    
    pendingContactId = nil
    let ts = Int(Date().timeIntervalSince1970 * 1000)

    // Send the event
    sendEvent(
      withName: "ContactAddedWithLocation",
      body: [
        "id": id, 
        "lat": coord.latitude, 
        "lng": coord.longitude, 
        "timestamp": ts
      ]
    )
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    print("Location error: \(error)")
    pendingContactId = nil
    manager.stopUpdatingLocation()
  }
}