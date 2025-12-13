use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{commit_accounts, commit_and_undelegate_accounts};
use session_keys::{session_auth_or, Session, SessionError, SessionToken};

declare_id!("DfJtsSqWNSetyRr3Fj4ZxM44oSBuZzAh4MTFMHQJSWvj");

// ========================================
// Game Constants (all in fixed-point with 1000 scale for precision)
// ========================================
pub const GAME_WIDTH: i32 = 600;
pub const GAME_HEIGHT: i32 = 400;
pub const BIRD_SIZE: i32 = 30;
pub const BIRD_X: i32 = 50; // Fixed X position

// Physics (scaled by 1000 for fixed-point)
// Physics (scaled by 1000 for fixed-point)
// Reverted to standard values now that Client drives ~20Hz ticks.
// 20Hz * 10px = 200px/sec (Approx 1/3 screen width per second). Good speed.
pub const GRAVITY: i32 = 600;        // 0.6 * 1000
pub const JUMP_VELOCITY: i32 = -9000; // -9.0 * 1000
pub const MAX_VELOCITY: i32 = 15000;  // 15.0 * 1000

// Pipe constants
pub const PIPE_WIDTH: i32 = 60;
pub const PIPE_GAP: i32 = 150;
pub const PIPE_SPEED: i32 = 10;       // 10 pixels per tick
pub const PIPE_SPAWN_DISTANCE: i32 = 200;
pub const MAX_PIPES: usize = 5;

// Random seed for pipe generation
pub const PIPE_HEIGHT_MIN: i32 = 50;
pub const PIPE_HEIGHT_MAX: i32 = 400;

#[ephemeral]
#[program]
pub mod flappy_bird {
    use super::*;

    /// Initialize a new game account
    /// Uses PDA derivation with player's public key
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        game.authority = ctx.accounts.authority.key();
        game.score = 0;
        game.high_score = 0;
        game.game_status = GameStatus::NotStarted;
        game.bird_y = GAME_HEIGHT / 2 * 1000; // Center, scaled
        game.bird_velocity = 0;
        game.frame_count = 0;
        game.last_update = Clock::get()?.unix_timestamp;
        
        // Initialize empty pipes
        for i in 0..MAX_PIPES {
            game.pipes[i] = Pipe {
                x: -100, // Off-screen
                gap_y: GAME_HEIGHT / 2,
                passed: false,
                active: false,
            };
        }
        game.next_pipe_spawn_x = GAME_WIDTH + PIPE_SPAWN_DISTANCE;
        game.seed = Clock::get()?.unix_timestamp as u64;
        
        msg!("Game initialized for player {}", game.authority);
        Ok(())
    }

    /// Start a new game - resets bird position and score
    #[session_auth_or(
        ctx.accounts.game.authority.key() == ctx.accounts.signer.key(),
        FlappyError::InvalidAuth
    )]
    pub fn start_game(ctx: Context<GameAction>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!(
            game.game_status != GameStatus::Playing,
            FlappyError::GameAlreadyStarted
        );
        
        game.score = 0;
        game.game_status = GameStatus::Playing;
        game.bird_y = GAME_HEIGHT / 2 * 1000;
        game.bird_velocity = 0;
        game.frame_count = 0;
        game.last_update = Clock::get()?.unix_timestamp;
        
        // Reset pipes
        for i in 0..MAX_PIPES {
            game.pipes[i] = Pipe {
                x: -100,
                gap_y: GAME_HEIGHT / 2,
                passed: false,
                active: false,
            };
        }
        game.next_pipe_spawn_x = GAME_WIDTH;
        game.seed = Clock::get()?.unix_timestamp as u64;
        
        msg!("Game started!");
        Ok(())
    }

    /// Player flaps (jumps) - this is the main input during gameplay
    #[session_auth_or(
        ctx.accounts.game.authority.key() == ctx.accounts.signer.key(),
        FlappyError::InvalidAuth
    )]
    pub fn flap(ctx: Context<GameAction>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        
        // Auto-start game if pending
        if game.game_status == GameStatus::NotStarted {
            game.game_status = GameStatus::Playing;
            game.last_update = Clock::get()?.unix_timestamp;
            msg!("Game auto-started by flap");
        }

        require!(
            game.game_status == GameStatus::Playing,
            FlappyError::GameNotPlaying
        );
        
        // Apply jump velocity
        game.bird_velocity = JUMP_VELOCITY;
        
        // Run one game tick
        update_game_physics(game)?;
        
        msg!("Flap! Bird Y: {}, Velocity: {}", game.bird_y / 1000, game.bird_velocity / 1000);
        Ok(())
    }

    /// Update game state - called each frame to advance physics
    /// This is the main game loop tick
    #[session_auth_or(
        ctx.accounts.game.authority.key() == ctx.accounts.signer.key(),
        FlappyError::InvalidAuth
    )]
    pub fn tick(ctx: Context<GameAction>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        require!(
            game.game_status == GameStatus::Playing,
            FlappyError::GameNotPlaying
        );
        
        update_game_physics(game)?;
        
        msg!("Tick {}: Bird Y={}, Score={}", game.frame_count, game.bird_y / 1000, game.score);
        Ok(())
    }

    /// End the game - called when collision detected or manually
    #[session_auth_or(
        ctx.accounts.game.authority.key() == ctx.accounts.signer.key(),
        FlappyError::InvalidAuth
    )]
    pub fn end_game(ctx: Context<GameAction>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        
        game.game_status = GameStatus::GameOver;
        
        // Update high score if needed
        if game.score > game.high_score {
            game.high_score = game.score;
        }
        
        msg!("Game Over! Score: {}, High Score: {}", game.score, game.high_score);
        Ok(())
    }

    /// Reset game to initial state
    #[session_auth_or(
        ctx.accounts.game.authority.key() == ctx.accounts.signer.key(),
        FlappyError::InvalidAuth
    )]
    pub fn reset_game(ctx: Context<GameAction>) -> Result<()> {
        let game = &mut ctx.accounts.game;
        
        game.score = 0;
        game.game_status = GameStatus::NotStarted;
        game.bird_y = GAME_HEIGHT / 2 * 1000;
        game.bird_velocity = 0;
        game.frame_count = 0;
        
        // Reset pipes
        for i in 0..MAX_PIPES {
            game.pipes[i] = Pipe {
                x: -100,
                gap_y: GAME_HEIGHT / 2,
                passed: false,
                active: false,
            };
        }
        game.next_pipe_spawn_x = GAME_WIDTH;
        
        msg!("Game reset!");
        Ok(())
    }

    // ========================================
    // MagicBlock Ephemeral Rollups Functions
    // ========================================

    /// Delegate the game account to the Ephemeral Rollup
    pub fn delegate(ctx: Context<DelegateInput>) -> Result<()> {
        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &[GAME_SEED, ctx.accounts.payer.key().as_ref()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        msg!("Game delegated to Ephemeral Rollup");
        Ok(())
    }

    /// Commit game state to the base layer
    pub fn commit(ctx: Context<CommitInput>) -> Result<()> {
        commit_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.game.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;
        msg!("Game state committed to base layer");
        Ok(())
    }

    /// Undelegate and commit final state
    pub fn undelegate(ctx: Context<CommitInput>) -> Result<()> {
        commit_and_undelegate_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.game.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;
        msg!("Game undelegated from Ephemeral Rollup");
        Ok(())
    }
}

// ========================================
// Game Physics & Logic
// ========================================

fn update_game_physics(game: &mut Account<GameState>) -> Result<()> {
    game.frame_count += 1;
    
    // Apply gravity to velocity
    game.bird_velocity += GRAVITY;
    
    // Clamp velocity
    if game.bird_velocity > MAX_VELOCITY {
        game.bird_velocity = MAX_VELOCITY;
    }
    if game.bird_velocity < -MAX_VELOCITY {
        game.bird_velocity = -MAX_VELOCITY;
    }
    
    // Update bird position
    game.bird_y += game.bird_velocity;
    
    // Check floor/ceiling collision
    let bird_y_pixels = game.bird_y / 1000;
    if bird_y_pixels <= 0 || bird_y_pixels + BIRD_SIZE >= GAME_HEIGHT {
        game.game_status = GameStatus::GameOver;
        if game.score > game.high_score {
            game.high_score = game.score;
        }
        return Ok(());
    }
    
    // Update pipes
    for i in 0..MAX_PIPES {
        if game.pipes[i].active {
            game.pipes[i].x -= PIPE_SPEED;
            
            // Check if pipe passed
            if !game.pipes[i].passed && game.pipes[i].x + PIPE_WIDTH < BIRD_X {
                game.pipes[i].passed = true;
                game.score += 1;
            }
            
            // Deactivate off-screen pipes
            if game.pipes[i].x + PIPE_WIDTH < 0 {
                game.pipes[i].active = false;
            }
            
            // Check collision with this pipe
            if check_pipe_collision(bird_y_pixels, &game.pipes[i]) {
                game.game_status = GameStatus::GameOver;
                if game.score > game.high_score {
                    game.high_score = game.score;
                }
                return Ok(());
            }
        }
    }
    
    // Spawn new pipes
    spawn_pipes(game)?;
    
    game.last_update = Clock::get()?.unix_timestamp;
    
    Ok(())
}

fn check_pipe_collision(bird_y: i32, pipe: &Pipe) -> bool {
    if !pipe.active {
        return false;
    }
    
    // Check if bird is within pipe X range
    if BIRD_X + BIRD_SIZE > pipe.x && BIRD_X < pipe.x + PIPE_WIDTH {
        // Check if bird is outside the gap
        let gap_top = pipe.gap_y - PIPE_GAP / 2;
        let gap_bottom = pipe.gap_y + PIPE_GAP / 2;
        
        if bird_y < gap_top || bird_y + BIRD_SIZE > gap_bottom {
            return true;
        }
    }
    
    false
}

fn spawn_pipes(game: &mut Account<GameState>) -> Result<()> {
    // Check if we need to spawn a new pipe
    let mut rightmost_x = 0;
    for i in 0..MAX_PIPES {
        if game.pipes[i].active && game.pipes[i].x > rightmost_x {
            rightmost_x = game.pipes[i].x;
        }
    }
    
    // Spawn new pipe if there's space
    if rightmost_x < GAME_WIDTH - PIPE_SPAWN_DISTANCE || rightmost_x == 0 {
        // Find an inactive pipe slot
        for i in 0..MAX_PIPES {
            if !game.pipes[i].active {
                // Generate pseudo-random gap position
                game.seed = game.seed.wrapping_mul(1103515245).wrapping_add(12345);
                let random_offset = ((game.seed / 65536) % 300) as i32;
                let gap_y = PIPE_HEIGHT_MIN + PIPE_GAP / 2 + random_offset;
                
                game.pipes[i] = Pipe {
                    x: GAME_WIDTH,
                    gap_y: gap_y.min(GAME_HEIGHT - PIPE_HEIGHT_MIN - PIPE_GAP / 2),
                    passed: false,
                    active: true,
                };
                break;
            }
        }
    }
    
    Ok(())
}

// ========================================
// Account Contexts
// ========================================

// Game version salt - increment to create fresh PDAs (v2 to fix stuck delegation)
pub const GAME_SEED: &[u8] = b"game_v2";

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + GameState::INIT_SPACE,
        seeds = [GAME_SEED, authority.key().as_ref()],
        bump
    )]
    pub game: Account<'info, GameState>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts, Session)]
pub struct GameAction<'info> {
    #[account(
        mut,
        seeds = [GAME_SEED, game.authority.key().as_ref()],
        bump
    )]
    pub game: Account<'info, GameState>,

    // Note: signer is NOT mut so session keys work without needing SOL
    pub signer: Signer<'info>,

    #[session(signer = signer, authority = game.authority.key())]
    pub session_token: Option<Account<'info, SessionToken>>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateInput<'info> {
    pub payer: Signer<'info>,
    /// CHECK: The PDA to delegate
    #[account(mut, del, seeds = [GAME_SEED, payer.key().as_ref()], bump)]
    pub pda: AccountInfo<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitInput<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [GAME_SEED, payer.key().as_ref()], bump)]
    pub game: Account<'info, GameState>,
}

// ========================================
// Account Data
// ========================================

#[account]
#[derive(InitSpace)]
pub struct GameState {
    /// Player who owns this game
    pub authority: Pubkey,
    /// Current score
    pub score: u64,
    /// Highest score achieved
    pub high_score: u64,
    /// Current game status
    pub game_status: GameStatus,
    /// Bird Y position (fixed-point, scaled by 1000)
    pub bird_y: i32,
    /// Bird velocity (fixed-point, scaled by 1000)
    pub bird_velocity: i32,
    /// Frame counter for timing
    pub frame_count: u64,
    /// Last update timestamp
    pub last_update: i64,
    /// Pipe data (up to 5 pipes on screen)
    #[max_len(5)]
    pub pipes: [Pipe; 5],
    /// X position for next pipe spawn
    pub next_pipe_spawn_x: i32,
    /// Random seed for pipe generation
    pub seed: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Default)]
pub struct Pipe {
    /// X position of pipe
    pub x: i32,
    /// Y position of gap center
    pub gap_y: i32,
    /// Whether bird has passed this pipe
    pub passed: bool,
    /// Whether pipe is active
    pub active: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Default)]
pub enum GameStatus {
    #[default]
    NotStarted,
    Playing,
    GameOver,
}


#[error_code]
pub enum FlappyError {
    #[msg("Game is not in playing state")]
    GameNotPlaying,
    #[msg("Game has already started")]
    GameAlreadyStarted,
    #[msg("Invalid authentication")]
    InvalidAuth,
}
