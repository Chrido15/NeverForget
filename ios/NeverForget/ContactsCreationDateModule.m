#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(ContactsCreationDateModule, NSObject)
RCT_EXTERN_METHOD(getPhoneDates:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
@end
