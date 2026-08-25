# Edit Connection Feature Test Guide

## Testing the Edit Connection Functionality

### Prerequisites
- Development server running on http://localhost:5174/
- No build errors

### Test Steps

1. **Open the application**
   - Navigate to http://localhost:5174/ in your browser

2. **Test the edit functionality in saved connections:**
   - Look for saved connections in the main interface
   - Click the ✎ (edit) button next to any connection
   - Verify the edit modal opens with:
     - Current connection name
     - Connection type selector
     - Appropriate fields for the selected type
     - Apply and Cancel buttons

3. **Test editing different connection types:**
   - **Stalker Connection**: Should show server URL, MAC address, and optional fields
   - **Xtream Connection**: Should show server URL, username, and password
   - **M3U Connection**: Should show playlist URL

4. **Test validation:**
   - Try to save with empty required fields
   - The connection should not reload if required fields are missing

5. **Test successful edit:**
   - Edit a connection with valid data
   - Click Apply
   - Verify the connection name updates
   - Verify the categories reload (Live TV, Movies, Series)

6. **Test edit in connections modal:**
   - Open the connections modal
   - Click the ✎ button next to any connection
   - Verify the same edit modal opens
   - Test editing and saving

### Expected Behavior
- Edit modal should open with current connection data
- Fields should be pre-populated with existing values
- Type selector should show the correct type
- Apply button should update the connection
- Categories should reload automatically for valid connections
- No "Invalid MAC format" errors should occur

### Error Scenarios to Verify
- Editing with empty required fields should not cause crashes
- Invalid MAC format errors should be prevented
- The application should continue working normally after edits