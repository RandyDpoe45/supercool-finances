import { OtpGenerationResult } from '../../service/interfaces/otp.service.interface';
import { OtpDto } from '../dto/otp.dto';

/** Explicit-whitelist serializer for the OTP generate response: lists each field by hand,
 * never spreads the service result. */
export function serializeOtp(result: OtpGenerationResult): OtpDto {
  return {
    code: result.code,
    ttlSeconds: result.ttlSeconds,
  };
}
