import jwt from 'jsonwebtoken';
import dotenv from 'dotenv'
dotenv.config();
import {z, ZodError} from 'zod'
import { NextFunction, Request, Response } from 'express';
import { User } from '../models/user.models';
import { SendEmail } from '../utils/email';
import speakeasy, { otpauthURL } from 'speakeasy'

const jwt_secret = process.env.JWT_SECRET as string || "";
const jwt_expiresIn = process.env.JWT_EXPIRES_IN;
const frontend_url = process.env.FRONTEND_URL;

// zod schemas for validation
const signupSchema = z.object({
    name: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(8),
});

const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8)
});


const verifyEmailSchema = z.object({
    token: z.string(),
});

const enable2FASchema = z.object({
    token: z.string(),
    code: z.string().length(6)
});


// Helper function to sign token
const signToken = (id: string) => {
    return jwt.sign({id}, jwt_secret, {
        expiresIn: jwt_expiresIn as jwt.SignOptions["expiresIn"]
    })
}


// SIGN UP
export const signup = async(req: Request, res: Response):Promise<void> => {
    try {
        const {name, email, password} = signupSchema.parse(req.body);
        const userExists = await User.findOne({email});
        if(userExists){
            res.status(400).json({
                success: false,
                message: "Email is already registered"
            })
            return
        };

        const newUser = await User.create({name, email, password});

        // Generate verification token
        const verificationToken = jwt.sign(
            {id: newUser._id}, jwt_secret + newUser.password, {expiresIn: '1d'}
        );

        // Send verification email
        const verificationUrl = `${frontend_url}/verify-email?token=${verificationToken}`;

        await SendEmail({
            email: newUser.email,
            subject: "Verify Your Email",
            html: `Please click <a href="${verificationUrl}"> here</a> to verify your email`
        })

        res.status(201).json({
            status: "sucess",
            message: "Verification email sent"
        })

    } catch (error) {
        if(error instanceof z.ZodError){
            res.status(400).json({
                status: "failed",
                message: error.errors
            });
            return
        }
        res.status(500).json({message: "Something went wrong"})
    }
};



// VERIFY EMAIL
export const verifyEmail = async(req: Request, res: Response): Promise<void> => {
    try {
        const {token} = verifyEmailSchema.parse(req.query);

        //Decode token
        const decodeToken = jwt.decode(token) as {id: string} || null;
        if(!decodeToken || !decodeToken.id){
             res.status(400).json({
                message: "Inavlid token"
            });
            return
        }

        const user = await User.findById(decodeToken.id);
        if(!user){
            res.status(400).json({
                message: "User with token not found"
            })
            return
        }
        
        // verify token
        jwt.verify(token, jwt_secret + user.password) ;

        if(user.isEmailVerified){
            res.status(400).json({
                message: "Email is already verified"
            });
            return;
        };

        user.isEmailVerified = true;
        await user.save();

        res.status(200).json({
            status: "success",
            message: "Email verified successfully"
        })

    } catch (error) {
        res.status(400).json({
            status: "Failed",
            message:"Token is invalid, or token is expired"
        })
    }
}


export const login = async(req: Request, res: Response): Promise<void> => {
    try {
        const {email, password} = loginSchema.parse(req.body);
        const user = await User.findOne({email}).select('+password');
        if(!user || !(await user.comparePassword(password))){
            res.status(401).json({
                status: "failed",
                message: "Invalid email or password"
            });
            return 
        }

        if(!user.isEmailVerified){
             res.status(401).json({message: 'Please verify your email to login'});
             return
        }

        // Check if 2FA is enabled
        if(user.twoFactorEnabled){
            const tempToken = jwt.sign({id: user._id}, jwt_secret, {expiresIn: '5m'});
            res.status(200).json({
                message: '2FA required',
                tempToken,
                twoFactorEnabled: true
            });
            return 
        };

        // Sign token
        const token = signToken(user._id.toString());

        // Set Cookie
        res.cookie('jwt', token, {
            expires: new Date(
                Date.now() + parseInt(process.env.COOKIE_EXPIRES_IN!) * 24 * 60 * 60 * 1000
            ),
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
        });

        res.status(200).json({
            status: "success",
            message: "Login successfull",
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role,
            }
        })

    } catch (error) {
        if(error instanceof z.ZodError){
             res.status(400).json({
                message: 'Validation failed',
                errors: error.errors,
              });
              return
        };
        res.status(500).json({message: "Something went wrong"});
    }
}


// SETUP 2 FACTOR AUTH;
export const setup2FA = async(req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user.id;
        const user = await User.findById(userId);
        if(!user){
            res.status(404).json({message: "User not found"});
            return 
        };

        if(user.twoFactorEnabled){
            res.status(400).json({message: '2FA already enabled'});
            return;
        };

        const secret = speakeasy.generateSecret({
            name: `ExpenseTracker:${user.email}`
        });

        user.twoFactorSecret = secret.base32;
        await user.save();

        res.status(200).json({
            secret: secret.base32,
            otpauthURL: secret.otpauth_url,
        })

    } catch (error) {
        res.status(500).json({ message: 'Something went wrong' });
    }
}

// Verify 2 Factor Authentication
export const verify2FA = async(req: Request, res: Response): Promise<void> => {
    try {
        const {tempToken, code} =  req.body;
        const decoded = jwt.verify(tempToken, jwt_secret) as {id: string};
        const user = await User.findById(decoded.id).select('+twoFactorSecret');

        if(!user || !user.twoFactorSecret){
             res.status(400).json({
                status: "failed",
                message: "Invalid token",
            });
            return
        }

        const verified = speakeasy.totp.verify({
            secret: user.twoFactorSecret,
            encoding: 'base32',
            token: code,
            window: 1,
        });

        if(!verified){
            res.status(401).json({message: "Invalid 2fA code"});
            return
        }

        const token = signToken(user._id.toString());

        res.cookie('jwt', token,{
            expires: new Date(
                Date.now() + parseInt(process.env.COOKIE_EXPIRES_IN!) * 24 * 60 * 60 * 1000
            ),
            httpOnly: true,
            secure: process.env.NODE_ENV=== 'production',
        });
        res.status(200).json({
            status: 'success',
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role
            },
        });

    } catch (error) {
        res.status(401).json({ message: 'Invalid or expired token' });
    }
}

// CONFIRM 2 FACTOR AUTH;
export const confirm2FA = async(req: Request, res: Response): Promise<void> => {
    try {
        const { code } = enable2FASchema.parse(req.body);
        const userId = req.user.id
        const user = await User.findById(userId).select('+twoFactorSecret');

        if(!user || !user.twoFactorSecret){
            res.status(404).json({
                messaage: "User not found or 2FA not setup"
            });
            return 
        };

        const verified = speakeasy.totp.verify({
            secret: user.twoFactorSecret,
            encoding: 'base32',
            token: code,
            window: 1
        });

        if(!verified){
            res.status(401).json({message: "invalid 2FA code"});
            return 
        }

        user.twoFactorEnabled = true;
        await user.save();

        res.status(200).json({
            message: "2FA Enabled successfully"
        })
        
    } catch (error) {
        if (error instanceof z.ZodError) {
            res.status(400).json({
              message: 'Validation failed',
              errors: error.errors,
            });
            return 
          }
          res.status(500).json({ message: 'Something went wrong' });
    }
};


// DISABLE 2 FACTOR AUTH
export const disable2FA = async (req: Request, res: Response): Promise<void> => {
    try {
        const userId = req.user.id;
        const user = await User.findById(userId);

        if(!user){
             res.status(404).json({
                message: "User not found"
            });
            return
        };
        if(!user.twoFactorEnabled){
           res.status(400).json({message: '2FA not enabled'});
           return
        };

        user.twoFactorEnabled = false;
        user.twoFactorSecret = undefined;
        await user.save()

        res.status(200).json({ message: '2FA disabled successfully' });

    } catch (error) {
        res.status(500).json({ message: 'Something went wrong', error });
    }
}


// LOGOUT
export const logout = (req: Request, res: Response) => {
   try {
    res.cookie('jwt', '', {
        // expires: new Date(Date.now() + 10 * 1000),
        expires: new Date(0),
        httpOnly: true
    });
    res.status(200).json({
        status: "success",
        message: "Logged out successfully"
    })
   } catch (error) {
    res.status(500).json({ message: 'Error Logging out', error });
   }
};


export const protect = async(req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        let token;
        if(req.headers.authorization && req.headers.authorization.startsWith("Bearer")){
            token = req.headers.authorization.split(' ')[1];
        }else if(req.cookies.jwt){
            token = req.cookies.jwt;
        };

        if(!token){
            res.status(401).json({
                message: 'You are not logged in!, Please log in to get access',
            });
            return
        };

        const decoded = jwt.verify(token, jwt_secret) as {id: string};
        const currentUser = await User.findById(decoded.id)
        if(!currentUser){
            res.status(401).json({
                message: 'User does no longer exist'
            });
            return 
        }

        req.user = currentUser;
        next();

    } catch (error) {
        res.status(401).json({ message: 'Invalid token' });
    }
}


// RESTRICTED TO
export const restrictTo = (...roles: string[]) => {
    return (req: Request, res: Response, next: Function)=> {
        if(!roles.includes(req.user.role)){
            return res.status(403).json({
                message: "You do not have permission to perform this action"
            })
        }
        next();
    }
}


