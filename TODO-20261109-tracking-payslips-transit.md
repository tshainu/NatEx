# NatEx follow-up updates — 9 November 2026

## Admin and tracking

- [x] Add an option to delete a batch of tracking numbers while leaving already-used numbers unchanged. Unused numbers in the selected batch may be retired; used/assigned numbers must remain valid and untouched.
- [x] Add a search option to the employee dropdown in Add User so HR/Admin can find registered employees before linking a login.

## HR payslips

- [x] Add a Payslips tab/option in HR. Allow selection of one staff member or all staff for a payroll period; generate employee payslips as PDFs and provide a bulk ZIP download containing one PDF per selected employee.

## Transit terminology and late-arrival alert

- [x] Replace user-visible “Linehaul” wording with “Transit” in menus and relevant Operations screens.
- [x] If the scheduled arrival time has passed by more than one hour and the trip is still not marked arrived, show a blinking “Not arrived yet” alert. Keep the actual trip state truthful (in transit); do not fabricate an arrival event.

## Release boundary

- [x] Implement and validate on a feature branch. Do not push or deploy to production until explicitly requested.
