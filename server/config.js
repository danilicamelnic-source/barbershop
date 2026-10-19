'use strict';
/*
 * ===== MY BARBER — BUSINESS SETTINGS =====
 * This file is the single source of truth for services, prices, durations and opening hours.
 * The website loads these values from the server (GET /api/config), and the server uses them
 * to calculate free slots and to validate every booking.
 *
 * After editing, restart the server (e.g. `sudo systemctl restart mybarber` or `npm start`).
 */
module.exports = {
  /*
   * WHAT THE OWNER HAS CONFIRMED. Set each to true only after the owner has checked that part of this file.
   * Anything still false (and any price that is still null) is listed as a warning at the top of /admin and in
   * the server log, so unverified details can't slip into launch unnoticed.
   */
  confirmedByOwner: {
    services: false,   // the list of services and their durations (taken from the public Fresha listing)
    hours: false,      // opening hours and days off (taken from the public Fresha listing)
    chairs: false,     // how many customers can be served at once (1 is an ASSUMPTION, not verified)
    bookingRules: false, // slot step, booking window, lead time, autoConfirm, per-phone limits
  },

  shopName: 'My Barber',
  timezone: 'Europe/Chisinau',   // all dates/times are Chișinău local time
  currency: 'MDL',

  // How many customers can be served at the same time (number of barbers/chairs working).
  // UNVERIFIED ASSUMPTION: Fresha listed "1+" practitioners. With 1, no two bookings can overlap.
  chairs: 1,

  slotStepMin: 30,      // start times offered every N minutes (10:00, 10:30, ...)
  bookingDays: 14,      // how many days ahead customers can book (including today)
  minLeadMin: 60,       // earliest booking = now + this many minutes

  // false = booking is saved as a REQUEST ("pending"): the slot is held and the shop confirms
  //         it in /admin (or by calling the customer).
  // true  = booking is confirmed immediately when the server saves it.
  autoConfirm: false,

  // Opening hours per weekday (0 = Sunday … 6 = Saturday). null = closed that day.
  // Source: public Fresha listing, checked 19 Oct 2026 — daily 10:00–19:00. Confirm with the owner.
  hours: {
    0: ['10:00', '19:00'],
    1: ['10:00', '19:00'],
    2: ['10:00', '19:00'],
    3: ['10:00', '19:00'],
    4: ['10:00', '19:00'],
    5: ['10:00', '19:00'],
    6: ['10:00', '19:00'],
  },
  closedDates: [],      // holidays / days off, e.g. ['2026-12-25', '2027-01-01']

  maxActivePerPhone: 3, // max upcoming active bookings per phone number
  retentionDays: 90,    // bookings (name, phone) are deleted this many days after the appointment date

  /*
   * Services. Durations are from the public Fresha listing (19 Oct 2026).
   * price: null  → PLACEHOLDER. The site shows "Price to be confirmed".
   *                Fresha showed 3/2/4/2/10 MDL, which look like placeholders, so they are NOT used.
   *                Replace null with the real price in MDL, e.g. price: 250
   * fromPrice: true shows "from 250 MDL" (use for services whose price varies).
   * The `id` must stay stable once bookings exist; the website translates names by id.
   */
  services: [
    { id: 'haircut',    duration: 40, price: null /* PLACEHOLDER */, fromPrice: true,  name: 'Tunsoare' },
    { id: 'beard',      duration: 30, price: null /* PLACEHOLDER */, fromPrice: false, name: 'Aranjarea bărbii' },
    { id: 'combo',      duration: 60, price: null /* PLACEHOLDER */, fromPrice: false, name: 'Complex: tunsoare + barbă' },
    { id: 'father-son', duration: 90, price: null /* PLACEHOLDER */, fromPrice: false, name: 'Tunsoare: tată + fiu' },
    { id: 'cosmetic',   duration: 15, price: null /* PLACEHOLDER */, fromPrice: false, name: 'Servicii cosmetice diverse' },
  ],
};
