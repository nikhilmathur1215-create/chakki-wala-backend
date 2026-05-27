import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
    stages: [
        { duration: '1m', target: 100 },
        { duration: '2m', target: 200 },
        { duration: '3m', target: 200 },
        { duration: '1m', target: 0 },
    ],
    thresholds: {
        http_req_duration: ['p(95)<1000'],
        http_req_failed: ['rate<0.05'],
    },
};

const BASE_URL = 'http://localhost:3000/api';

export default function() {
    // Generate unique mobile number for each virtual user
    const uniqueMobile = `99${__VU}${__ITER}`.slice(0, 10);
    
    // Health check (always passes)
    let healthRes = http.get(`${BASE_URL}/health`);
    check(healthRes, { 'health': (r) => r.status === 200 });
    
    // OTP request with unique mobile number (only 10% of users)
    if (__VU % 10 === 0) {
        let otpRes = http.post(`${BASE_URL}/auth/send-otp`, JSON.stringify({
            mobile: uniqueMobile
        }), { headers: { 'Content-Type': 'application/json' } });
        
        check(otpRes, { 'otp sent': (r) => r.status === 200 });
        
        // If OTP sent successfully, verify it
        if (otpRes.status === 200 && otpRes.json().testOtp) {
            let verifyRes = http.post(`${BASE_URL}/auth/verify-otp`, JSON.stringify({
                mobile: uniqueMobile,
                otp: otpRes.json().testOtp
            }), { headers: { 'Content-Type': 'application/json' } });
            check(verifyRes, { 'otp verified': (r) => r.status === 200 });
        }
    }
    
    sleep(1);
}
