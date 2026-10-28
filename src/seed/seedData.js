'use strict';

// Reference data for the demo campus. Hourly values are the expected number of
// arrivals in that clock hour on a normal weekday; dayFactor is indexed by
// Date#getDay() (0 = Sunday) and scales the whole day.

const DEMO_ACCOUNTS = {
  admin: { email: 'admin@qws.edu', password: 'Admin@123', name: 'Priya Raman' },
  staff: { email: 'staff@qws.edu', password: 'Staff@123' },
  customer: { email: 'student@qws.edu', password: 'Student@123', name: 'Arjun Mehta' },
};

const CENTERS = [
  {
    name: 'Main Canteen',
    category: 'canteen',
    location: 'Block A, Ground Floor',
    description: 'Breakfast, lunch, snacks and beverages for students and faculty.',
    open: '07:30',
    close: '21:00',
    services: [
      { name: 'Meals', code: 'M', avg: 4, fee: 60, weight: 0.45, description: 'South & North Indian thali, rice combos' },
      { name: 'Snacks & Beverages', code: 'S', avg: 2, fee: 25, weight: 0.4, description: 'Tea, coffee, juices, puffs and sandwiches' },
      { name: 'Parcel / Takeaway', code: 'P', avg: 3, fee: 10, weight: 0.15, description: 'Packed meals to go' },
    ],
    counters: [
      { label: 'Counter 1 - Meals', services: ['M', 'P'] },
      { label: 'Counter 2 - Snacks', services: ['S'] },
      { label: 'Counter 3 - Express', services: ['M', 'S', 'P'] },
    ],
    slots: [['12:00', '12:30', 20], ['12:30', '13:00', 20], ['13:00', '13:30', 20], ['13:30', '14:00', 20]],
    slotRate: 0.12,
    hourly: { 7: 6, 8: 14, 9: 16, 10: 22, 11: 16, 12: 40, 13: 46, 14: 18, 15: 14, 16: 26, 17: 16, 18: 9, 19: 14, 20: 7 },
    dayFactor: [0.3, 1.05, 1, 1, 1, 0.95, 0.55],
  },
  {
    name: 'Xerox & Print Hub',
    category: 'photocopy',
    location: 'Library Annex, Room 004',
    description: 'Photocopies, laser printing and spiral binding for assignments and records.',
    open: '08:30',
    close: '18:00',
    services: [
      { name: 'Photocopy', code: 'X', avg: 2.5, fee: 1, weight: 0.55, description: 'B/W and colour photocopies' },
      { name: 'Printing', code: 'PR', avg: 3.5, fee: 2, weight: 0.3, description: 'Print from pen drive or email' },
      { name: 'Spiral Binding', code: 'B', avg: 7, fee: 40, weight: 0.15, description: 'Record and project binding' },
    ],
    counters: [
      { label: 'Desk 1 - Copy & Print', services: ['X', 'PR'] },
      { label: 'Desk 2 - All Services', services: ['X', 'PR', 'B'] },
    ],
    slots: [['09:00', '10:00', 12], ['15:00', '16:00', 12]],
    slotRate: 0.1,
    hourly: { 8: 6, 9: 22, 10: 15, 11: 10, 12: 8, 13: 9, 14: 13, 15: 24, 16: 16, 17: 6 },
    dayFactor: [0, 1, 1, 1.1, 1, 1.15, 0.4],
  },
  {
    name: 'Campus Health Clinic',
    category: 'clinic',
    location: 'Admin Block, First Floor',
    description: 'General physician consultation, pharmacy and first aid.',
    open: '09:00',
    close: '17:00',
    services: [
      { name: 'General Consultation', code: 'C', avg: 9, fee: 0, weight: 0.45, description: 'Doctor consultation', slotRate: 0.35 },
      { name: 'Pharmacy', code: 'PH', avg: 3, fee: 0, weight: 0.4, description: 'Collect prescribed medicines' },
      { name: 'First Aid', code: 'FA', avg: 6, fee: 0, weight: 0.15, description: 'Minor injuries and dressing', priorityRate: 0.5 },
    ],
    counters: [
      { label: 'Doctor Room 1', services: ['C'] },
      { label: 'Doctor Room 2', services: ['C', 'FA'] },
      { label: 'Pharmacy Window', services: ['PH'] },
    ],
    slots: [
      ['09:00', '10:00', 5], ['10:00', '11:00', 5], ['11:00', '12:00', 5], ['12:00', '13:00', 5],
      ['14:00', '15:00', 5], ['15:00', '16:00', 5], ['16:00', '17:00', 5],
    ],
    slotRate: 0,
    hourly: { 9: 8, 10: 12, 11: 11, 12: 7, 13: 5, 14: 8, 15: 7, 16: 5 },
    dayFactor: [0, 1.15, 1, 1, 1, 0.9, 0.5],
  },
  {
    name: 'Student Services Office',
    category: 'office',
    location: 'Admin Block, Ground Floor',
    description: 'Bonafide certificates, fee queries and ID card services.',
    open: '09:30',
    close: '16:30',
    services: [
      { name: 'Bonafide Certificate', code: 'BC', avg: 5, fee: 0, weight: 0.4, description: 'Bonafide and study certificates' },
      { name: 'Fee Queries', code: 'F', avg: 7, fee: 0, weight: 0.35, description: 'Fee receipts, dues and refunds' },
      { name: 'ID Card Services', code: 'ID', avg: 6, fee: 100, weight: 0.25, description: 'New, duplicate and corrected ID cards' },
    ],
    counters: [
      { label: 'Window A', services: ['BC', 'ID'] },
      { label: 'Window B', services: ['F', 'BC'] },
    ],
    slots: [['10:00', '11:00', 8], ['11:00', '12:00', 8], ['14:00', '15:00', 8], ['15:00', '16:00', 8]],
    slotRate: 0.2,
    hourly: { 9: 4, 10: 10, 11: 9, 12: 6, 13: 3, 14: 8, 15: 7, 16: 3 },
    dayFactor: [0, 1.25, 1, 1, 0.95, 0.9, 0],
  },
];

const STAFF_NAMES = [
  ['Ravi Kumar', 'Canteen Supervisor'],
  ['Lakshmi Narayanan', 'Canteen Cashier'],
  ['Suresh Babu', 'Canteen Cashier'],
  ['Meena Joseph', 'Print Operator'],
  ['Karthik Raja', 'Print Operator'],
  ['Dr. Anitha Rao', 'Medical Officer'],
  ['Dr. Vikram Shetty', 'Medical Officer'],
  ['Farah Siddiqui', 'Pharmacist'],
  ['Gopal Iyer', 'Office Assistant'],
  ['Deepa Menon', 'Accounts Assistant'],
];

const CUSTOMER_NAMES = [
  'Aditi Sharma', 'Rahul Verma', 'Sneha Reddy', 'Mohammed Irfan', 'Kavya Nair', 'Rohan Das', 'Ishita Gupta',
  'Vignesh Subramanian', 'Pooja Patel', 'Aarav Singh', 'Nandini Pillai', 'Siddharth Rao', 'Harini Venkat',
  'Yash Agarwal', 'Divya Krishnan', 'Abdul Rahman', 'Tanvi Joshi', 'Pranav Menon', 'Shreya Banerjee',
  'Karan Malhotra', 'Lavanya Srinivasan', 'Nikhil Jain', 'Ritika Chawla', 'Sanjay Murugan', 'Ayesha Khan',
  'Varun Hegde', 'Meghana Gowda', 'Akash Pandey', 'Sowmya Raghavan', 'Dev Kapoor', 'Fathima Beevi',
  'Gautham Krishna', 'Anjali Mishra', 'Tarun Bhat', 'Riya Thomas', 'Manoj Kumar', 'Keerthana Selvam',
  'Zoya Ahmed', 'Hrithik Saxena', 'Bhavana Shetty', 'Naveen Prakash', 'Esha Kulkarni',
];

// Extra generated customers so visit counts per student stay realistic
const FIRST_NAMES = [
  'Aakash', 'Bhavya', 'Chetan', 'Dhanya', 'Elango', 'Gayathri', 'Hari', 'Indu', 'Jaya', 'Kiran', 'Latha', 'Madhav',
  'Nisha', 'Pavan', 'Rekha', 'Sameer', 'Teja', 'Uma', 'Vasanth', 'Yamini', 'Arun', 'Brinda', 'Charan', 'Janani',
];
const LAST_NAMES = [
  'Acharya', 'Bose', 'Chandran', 'Dutta', 'Easwaran', 'Fernando', 'Ganesan', 'Hussain', 'Iyengar', 'Kamath',
  'Lobo', 'Mani', 'Naidu', 'Oommen', 'Prasad', 'Qureshi', 'Rajan', 'Sethi', 'Tiwari', 'Varghese',
];
const GENERATED_CUSTOMERS = 160;

// Registered but never used the system (feeds the "inactive customers" report)
const IDLE_CUSTOMER_NAMES = ['Omkar Deshpande', 'Swathi Rajan', 'Jason Fernandes'];

const FEEDBACK_COMMENTS = {
  5: ['Super quick, did not have to stand at all!', 'Got the alert right on time.', 'Very smooth, staff were friendly.', 'Best thing on campus.', null, null],
  4: ['Pretty fast, slight delay at the counter.', 'Good experience overall.', 'Estimated time was accurate.', null, null],
  3: ['Okay, waited a bit longer than shown.', 'Average, counter was busy.', null],
  2: ['Waited too long during lunch rush.', 'Estimated time was way off.', 'Only one counter was open.'],
  1: ['Very long wait, token was skipped once.', 'Counter closed while I was waiting.'],
};

function generatedCustomerNames() {
  const names = [];
  for (let i = 0; names.length < GENERATED_CUSTOMERS; i += 1) {
    const name = `${FIRST_NAMES[i % FIRST_NAMES.length]} ${LAST_NAMES[(i * 7 + Math.floor(i / FIRST_NAMES.length)) % LAST_NAMES.length]}`;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

module.exports = {
  DEMO_ACCOUNTS, CENTERS, STAFF_NAMES, CUSTOMER_NAMES, IDLE_CUSTOMER_NAMES, FEEDBACK_COMMENTS, generatedCustomerNames,
};
