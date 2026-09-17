// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/**
 * @notice Pays a netted tip epoch in one transaction.
 * @dev Atomic by construction: any failed leg reverts the whole batch. A partial
 *      batch would settle some creditors and silently leave the rest owed, which
 *      the offchain ledger has no way to detect — it records one epoch, settled
 *      or not. All-or-nothing keeps the onchain effect equal to the plan.
 *
 *      Holds no funds and has no owner. It moves tokens the caller has already
 *      approved, so a compromised key cannot drain anything the caller had not
 *      already allowed to be spent.
 */
contract TipDisperser {
    error LengthMismatch(uint256 recipients, uint256 values);
    error EmptyBatch();
    error TransferFailed(address recipient, uint256 value);

    event Dispersed(address indexed token, address indexed payer, uint256 count, uint256 total);

    function disperseToken(
        address token,
        address[] calldata recipients,
        uint256[] calldata values
    ) external {
        if (recipients.length != values.length) {
            revert LengthMismatch(recipients.length, values.length);
        }
        if (recipients.length == 0) revert EmptyBatch();

        uint256 total;
        for (uint256 i = 0; i < recipients.length; ++i) {
            bool ok = IERC20(token).transferFrom(msg.sender, recipients[i], values[i]);
            if (!ok) revert TransferFailed(recipients[i], values[i]);
            total += values[i];
        }

        emit Dispersed(token, msg.sender, recipients.length, total);
    }
}
